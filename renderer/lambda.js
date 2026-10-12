/**
 * The AWS Lambda entry point: the event is render()'s input, the result its output. A bad
 * document comes back as { error } rather than a Lambda failure, so the caller can show why.
 */

import { render } from './render.js';

export async function handler(event) {
  try {
    return await render(typeof event === 'string' ? JSON.parse(event) : event);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}
