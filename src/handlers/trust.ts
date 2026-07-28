import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { trustRepliedMember, trustedMemberCount } from "./moderation.js";

const composer = new Composer<Ctx>();

composer.command("trust", async (ctx) => {
  if (!trustRepliedMember(ctx)) { await ctx.reply("Reply to a member’s message with /trust to add them to the trust list."); return; }
  await ctx.reply("That member is now trusted.");
});

composer.callbackQuery("trust:show", async (ctx) => {
  await ctx.answerCallbackQuery();
  const count = trustedMemberCount(ctx);
  await ctx.editMessageText(count === 0 ? "No trusted members yet — reply to a member with /trust to add one." : `${count} trusted member${count === 1 ? " is" : "s are"} excluded from automatic moderation.`, { reply_markup: inlineKeyboard([[inlineButton("Back to settings", "settings:open")]]) });
});

export default composer;
