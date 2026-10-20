/**
 * Durable message constructors for the inner loop.
 *
 * `ctx.llm` speaks durable `Message` values, so the run's own history is built
 * with the same constructors the host uses. Keeping them in one module lets
 * the loop stay host-free: tests inject a plain-object factory instead.
 *
 * @module dsh-reverie/messages
 */

import { createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";

/** @type {{user: Function, assistant: Function, toolResult: Function}} */
export const messageFactories = {
  /**
   * Build one user-role message.
   * @param {{text: string}} input - message text.
   * @returns {unknown} durable user message.
   */
  user({ text }) {
    return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
  },
  /**
   * Build one model-produced assistant message.
   * @param {{blocks: any[], provider: string, model: string}} input - content and route.
   * @returns {unknown} durable assistant message.
   */
  assistant({ blocks, provider, model }) {
    return createAssistantMessage({ content: blocks, source: { provider, model } });
  },
  /**
   * Build one tool-result message.
   * @param {{callId: string, text: string, isError: boolean}} input - result.
   * @returns {unknown} durable tool message.
   */
  toolResult({ callId, text, isError }) {
    return createToolResultMessage({ callId, content: [{ type: "text", text }], isError });
  },
};
