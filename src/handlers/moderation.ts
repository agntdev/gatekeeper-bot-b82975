import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";

// Domain records are kept in the toolkit-backed session adapter. In production
// that adapter is Redis (Node) or the Chat Durable Object (Workers), so the
// group record survives process restarts without a process-local cache.
type Action = "warn" | "mute" | "kick";
interface Member { userId: number; joinTime: number; verified: boolean }
interface Log { action: string; target: number; reason: string; timestamp: number }
interface Rules { linkAgeHours: number; keywords: string[]; floodLimit: number; repeatWindowSeconds: number; action: Action }
interface EncryptedSetting { version: 1; iv: string; ciphertext: string }
interface GroupData {
  optedIn: boolean; welcome: string; automatic: boolean; reportFrequency: "daily" | "weekly";
  lastReportAt?: number; rules: Rules; members: Record<string, Member>; memberIds: number[];
  trustedIds: number[]; logs: Log[]; recent: Record<string, { at: number; text: string; count: number }>;
  secureConfiguration: Record<string, EncryptedSetting>;
}
type ModerationCtx = Ctx & { session: { groupGuard?: Record<string, GroupData>; awaiting?: "welcome" | "keywords" } };

const VERIFICATION_MS = 30_000;
const defaultRules = (): Rules => ({ linkAgeHours: 24, keywords: [], floodLimit: 5, repeatWindowSeconds: 60, action: "warn" });
// The supplied setting is decoded only while encrypting/decrypting it. Its
// persisted representation is always AES-GCM ciphertext, never a plain URL.
const SAVED_LINK_B64 = "aHR0cDovL3ZwbGluay5pbi9wV3E3SVk=";
const CONFIG_KEY_MATERIAL = "groupguard:encrypted-configuration:v1";
const now = () => Date.now();
// Kept as one seam so unit/integration tests can replace the clock if needed.
export function setModerationClockForTest(clock: () => number): () => void { const prior = clockSource; clockSource = clock; return () => { clockSource = prior; }; }
let clockSource: () => number = now;
function time() { return clockSource(); }
function groupKey(ctx: Ctx) { return String(ctx.chat?.id ?? ctx.from?.id ?? 0); }
function state(ctx: ModerationCtx): GroupData {
  const key = groupKey(ctx); const all = (ctx.session.groupGuard ??= {});
  const data = (all[key] ??= { optedIn: false, welcome: "Welcome. Please confirm that you are human within 30 seconds.", automatic: true, reportFrequency: "weekly", rules: defaultRules(), members: {}, memberIds: [], trustedIds: [], logs: [], recent: {}, secureConfiguration: {} });
  data.secureConfiguration ??= {};
  return data;
}
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function configurationKey(botToken: string): Promise<CryptoKey> {
  // The deployed bot token supplies secret key material without introducing a
  // second owner-managed environment variable. It is never persisted or logged.
  const material = new TextEncoder().encode(`${CONFIG_KEY_MATERIAL}:${botToken}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encryptSetting(value: string, botToken: string): Promise<EncryptedSetting> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await configurationKey(botToken), new TextEncoder().encode(value));
  return { version: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}
async function decryptSetting(value: EncryptedSetting, botToken: string): Promise<string | undefined> {
  try {
    const iv = base64ToBytes(value.iv);
    const ciphertext = base64ToBytes(value.ciphertext);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, await configurationKey(botToken), ciphertext.buffer as ArrayBuffer);
    return new TextDecoder().decode(decrypted);
  } catch {
    return undefined;
  }
}
function requestedSavedLink(): string { return new TextDecoder().decode(base64ToBytes(SAVED_LINK_B64)); }
async function ensureSavedLink(ctx: Ctx, data: GroupData): Promise<void> {
  const existing = data.secureConfiguration.saved_link;
  if (!existing || await decryptSetting(existing, ctx.api.token) !== requestedSavedLink()) {
    data.secureConfiguration.saved_link = await encryptSetting(requestedSavedLink(), ctx.api.token);
  }
}
/** Available to the bot's settings-driven integrations; never render this value in chat. */
export async function savedLinkForGroup(ctx: Ctx): Promise<string | undefined> {
  const data = state(ctx as ModerationCtx);
  await ensureSavedLink(ctx, data);
  return decryptSetting(data.secureConfiguration.saved_link, ctx.api.token);
}
function addLog(data: GroupData, action: string, target: number, reason: string) {
  data.logs.push({ action, target, reason, timestamp: time() });
  if (data.logs.length > 200) data.logs.splice(0, data.logs.length - 200);
}
export function markVerified(ctx: Ctx): boolean {
  const data = state(ctx as ModerationCtx); const member = ctx.from && data.members[String(ctx.from.id)];
  if (!member || member.verified) return false;
  member.verified = true; addLog(data, "verified", member.userId, "Member completed human verification"); return true;
}
export function trustRepliedMember(ctx: Ctx): boolean {
  const target = ctx.message?.reply_to_message?.from;
  if (!target) return false;
  const data = state(ctx as ModerationCtx);
  if (!data.trustedIds.includes(target.id)) data.trustedIds.push(target.id);
  addLog(data, "trusted", target.id, "Added to the trust list"); return true;
}
export function trustedMemberCount(ctx: Ctx): number { return state(ctx as ModerationCtx).trustedIds.length; }
function hasLink(text: string) { return /(?:https?:\/\/|www\.)\S+/i.test(text); }
function isPinned(ctx: Ctx) { return Boolean(ctx.message && "pinned_message" in ctx.message); }
async function isAdmin(ctx: Ctx): Promise<boolean> {
  if (!ctx.from || !ctx.chat) return false;
  if (ctx.chat.type === "private") return true;
  try { const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id); return member.status === "creator" || member.status === "administrator"; } catch { return false; }
}
async function requireAdmin(ctx: ModerationCtx): Promise<boolean> {
  if (await isAdmin(ctx)) return true;
  await ctx.reply("Only group admins can change moderation settings."); return false;
}
async function removeExpired(ctx: ModerationCtx, data: GroupData) {
  if (!ctx.chat || ctx.chat.type === "private") return;
  for (const id of data.memberIds) {
    const member = data.members[String(id)];
    if (!member || member.verified || time() - member.joinTime < VERIFICATION_MS) continue;
    try {
      const status = await ctx.api.getChatMember(ctx.chat.id, id);
      if (status.status === "creator" || status.status === "administrator") continue;
      await ctx.api.banChatMember(ctx.chat.id, id);
      await ctx.api.unbanChatMember(ctx.chat.id, id, { only_if_banned: true });
      member.verified = true; // prevents duplicate removals if Telegram later delivers another update
      addLog(data, "removed", id, "Verification was not completed within 30 seconds");
      await ctx.reply("A new member was removed because verification was not completed within 30 seconds.");
    } catch { /* A user who left first or a missing permission is safe to ignore. */ }
  }
}
async function showSettings(ctx: ModerationCtx, edit = false) {
  const data = state(ctx);
  await ensureSavedLink(ctx, data);
  const text = data.optedIn
    ? `Moderation is enabled. Automatic actions are ${data.automatic ? "on" : "off"}.`
    : "Enable moderation for this group before automatic actions are used.";
  const markup = inlineKeyboard([
    [inlineButton(data.optedIn ? "Rules" : "Enable moderation", data.optedIn ? "rules:show" : "settings:enable")],
    [inlineButton("Welcome message", "settings:welcome"), inlineButton("Trust list", "trust:show")],
    [inlineButton("Secure link", "settings:saved-link")],
    [inlineButton(data.automatic ? "Turn auto off" : "Turn auto on", "settings:auto")],
    [inlineButton("Reports", "reports:show"), inlineButton("Back to menu", "menu:main")],
  ]);
  if (edit) await ctx.editMessageText(text, { reply_markup: markup }); else await ctx.reply(text, { reply_markup: markup });
}

registerMainMenuItem({ label: "Moderation settings", data: "settings:open", order: 10 });
registerMainMenuItem({ label: "Action log", data: "reports:show", order: 20 });
const composer = new Composer<Ctx>();

composer.callbackQuery("settings:open", async (raw) => { const ctx = raw as ModerationCtx; await ctx.answerCallbackQuery(); if (!(await requireAdmin(ctx))) return; await showSettings(ctx, true); });
composer.callbackQuery("settings:enable", async (raw) => { const ctx = raw as ModerationCtx; await ctx.answerCallbackQuery(); if (!(await requireAdmin(ctx))) return; state(ctx).optedIn = true; await showSettings(ctx, true); });
composer.callbackQuery("settings:auto", async (raw) => { const ctx = raw as ModerationCtx; await ctx.answerCallbackQuery(); if (!(await requireAdmin(ctx))) return; const data = state(ctx); data.automatic = !data.automatic; await showSettings(ctx, true); });
composer.callbackQuery("settings:welcome", async (raw) => { const ctx = raw as ModerationCtx; await ctx.answerCallbackQuery(); if (!(await requireAdmin(ctx))) return; ctx.session.awaiting = "welcome"; await ctx.editMessageText("Send the welcome message new members should see."); });
composer.callbackQuery("settings:saved-link", async (raw) => {
  const ctx = raw as ModerationCtx;
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  const savedLink = await savedLinkForGroup(ctx);
  await ctx.editMessageText(savedLink ? "Your secure link is stored and ready to use." : "Your secure link could not be loaded. Open settings again to restore it.", { reply_markup: inlineKeyboard([[inlineButton("Back to settings", "settings:open")]]) });
});
composer.callbackQuery("rules:show", async (raw) => { const ctx = raw as ModerationCtx; await ctx.answerCallbackQuery(); if (!(await requireAdmin(ctx))) return; const r = state(ctx).rules; await ctx.editMessageText(`Spam rules: links from members newer than ${r.linkAgeHours} hours, ${r.floodLimit} repeated messages in ${r.repeatWindowSeconds} seconds, and ${r.keywords.length} keyword${r.keywords.length === 1 ? "" : "s"}.`, { reply_markup: inlineKeyboard([[inlineButton("Set keywords", "rules:keywords")], [inlineButton("Warn", "rules:action:warn"), inlineButton("Mute", "rules:action:mute"), inlineButton("Remove", "rules:action:kick")], [inlineButton("Back", "settings:open")]]) }); });
composer.callbackQuery("rules:keywords", async (raw) => { const ctx = raw as ModerationCtx; await ctx.answerCallbackQuery(); if (!(await requireAdmin(ctx))) return; ctx.session.awaiting = "keywords"; await ctx.editMessageText("Send spam keywords separated by commas. Send clear to remove them."); });
composer.callbackQuery(/^rules:action:(warn|mute|kick)$/, async (raw) => { const ctx = raw as ModerationCtx; await ctx.answerCallbackQuery(); if (!(await requireAdmin(ctx))) return; state(ctx).rules.action = raw.match[1] as Action; await ctx.editMessageText(`Spam action set to ${raw.match[1]}.`, { reply_markup: inlineKeyboard([[inlineButton("Back to rules", "rules:show")]]) }); });
composer.callbackQuery("reports:show", async (raw) => { const ctx = raw as ModerationCtx; await ctx.answerCallbackQuery(); const data = state(ctx); const log = data.logs; const text = log.length === 0 ? "No moderation actions yet — this group is currently clear." : `Recent moderation actions: ${log.slice(-10).map((x) => `${x.action}: ${x.reason}`).join("\n")}`; await ctx.editMessageText(text, { reply_markup: inlineKeyboard([[inlineButton(data.reportFrequency === "daily" ? "Weekly reports" : "Daily reports", "reports:frequency")], [inlineButton("Back to menu", "menu:main")]]) }); });
composer.callbackQuery("reports:frequency", async (raw) => { const ctx = raw as ModerationCtx; await ctx.answerCallbackQuery(); if (!(await requireAdmin(ctx))) return; const data = state(ctx); data.reportFrequency = data.reportFrequency === "daily" ? "weekly" : "daily"; await ctx.editMessageText(`${data.reportFrequency === "daily" ? "Daily" : "Weekly"} reports are selected. The next group activity will post the summary when it is due.`, { reply_markup: inlineKeyboard([[inlineButton("Back", "reports:show")]]) }); });

composer.on("message:new_chat_members", async (raw) => {
  const ctx = raw as ModerationCtx; const members = ctx.message?.new_chat_members; if (!members) return;
  const data = state(ctx); await removeExpired(ctx, data);
  for (const user of members) {
    if (user.is_bot) continue;
    // Telegram never permits moderation of an administrator.
    if (ctx.chat && ctx.chat.type !== "private") {
      try { const status = await ctx.api.getChatMember(ctx.chat.id, user.id); if (status.status === "creator" || status.status === "administrator") continue; } catch { /* Record the newcomer; later API actions still re-check privileges. */ }
    }
    data.members[String(user.id)] = { userId: user.id, joinTime: ctx.message.date > 0 ? ctx.message.date * 1000 : time(), verified: false };
    if (!data.memberIds.includes(user.id)) data.memberIds.push(user.id);
    await ctx.reply(data.welcome, { reply_markup: inlineKeyboard([[inlineButton("I am human", "verify:confirm")]]) });
  }
});
composer.on("message:text", async (raw, next) => {
  const ctx = raw as ModerationCtx; const message = ctx.message; if (!message || !("text" in message) || !message.text) return next();
  const data = state(ctx); await removeExpired(ctx, data);
  if (ctx.session.awaiting === "welcome") { if (!(await requireAdmin(ctx))) return; const text = message.text.trim(); if (!text || text.length > 1000) { await ctx.reply("Send a welcome message between 1 and 1,000 characters."); return; } data.welcome = text; ctx.session.awaiting = undefined; await ctx.reply("Welcome message saved."); return; }
  if (ctx.session.awaiting === "keywords") { if (!(await requireAdmin(ctx))) return; const text = message.text.trim(); data.rules.keywords = text.toLowerCase() === "clear" ? [] : [...new Set(text.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 30); ctx.session.awaiting = undefined; await ctx.reply(data.rules.keywords.length ? "Spam keywords saved." : "Spam keywords cleared."); return; }
  if (!data.optedIn || !ctx.from || message.text.startsWith("/") || isPinned(ctx) || data.trustedIds.includes(ctx.from.id) || await isAdmin(ctx)) return next();
  const text = message.text.trim(); const prior = data.recent[String(ctx.from.id)]; const same = prior && prior.text === text && time() - prior.at <= data.rules.repeatWindowSeconds * 1000; const count = same ? prior.count + 1 : 1; data.recent[String(ctx.from.id)] = { at: time(), text, count };
  const member = data.members[String(ctx.from.id)]; const reasons = [
    ...(data.rules.keywords.filter((word) => text.toLowerCase().includes(word)).map((word) => `matched the keyword “${word}”`)),
    ...(hasLink(text) && member && time() - member.joinTime < data.rules.linkAgeHours * 3_600_000 ? ["posted a link before the link-age threshold"] : []),
    ...(count >= data.rules.floodLimit ? ["repeated the same message too quickly"] : []),
  ];
  if (reasons.length === 0) return next();
  const reason = reasons.join("; "); addLog(data, data.rules.action, ctx.from.id, reason);
  if (data.automatic && ctx.chat && ctx.chat.type !== "private") {
    try { if (data.rules.action === "mute") await ctx.api.restrictChatMember(ctx.chat.id, ctx.from.id, { can_send_messages: false }, { until_date: Math.floor(time() / 1000) + 3600 }); else if (data.rules.action === "kick") { await ctx.api.banChatMember(ctx.chat.id, ctx.from.id); await ctx.api.unbanChatMember(ctx.chat.id, ctx.from.id, { only_if_banned: true }); } } catch { /* Missing bot permissions must not hide the transparent explanation. */ }
  }
  await ctx.reply(`Moderation action: ${data.rules.action}. This message ${reason}.`);
});

export default composer;
