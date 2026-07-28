import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { markVerified } from "./moderation.js";

const composer = new Composer<Ctx>();

composer.callbackQuery("verify:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(markVerified(ctx) ? "You’re verified. You can take part in the group." : "Your verification has already been recorded.");
});

export default composer;
