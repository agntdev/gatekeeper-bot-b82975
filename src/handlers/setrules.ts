import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";

registerMainMenuItem({ label: "Spam rules", data: "setrules:open", order: 11 });
const composer = new Composer<Ctx>();

composer.command("setrules", async (ctx) => {
  await ctx.reply("Open Spam rules from the menu to set keywords and the moderation action.", { reply_markup: inlineKeyboard([[inlineButton("Open spam rules", "settings:open")]]) });
});

composer.callbackQuery("setrules:open", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText("Open Moderation settings to configure spam rules.", { reply_markup: inlineKeyboard([[inlineButton("Open settings", "settings:open")]]) }); });

export default composer;
