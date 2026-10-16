/**
 * The AWS Lambda entry point. Two operations, chosen by `op`:
 *
 *   { op: 'plan', doc }                          -> plan()'s output: what to read
 *   { doc, readings, now, timeZone, display }    -> render()'s output (no `op`, or 'render')
 *
 * A bad request comes back as { error } rather than a Lambda failure, so the caller can show why.
 */

import { render, plan } from './render.js';

export async function handler(event) {
  try {
    const input = typeof event === 'string' ? JSON.parse(event) : event;
    if (input?.op === 'plan') return plan(input);
    if (input?.op && input.op !== 'render') throw new Error(`unknown op "${input.op}"`);
    return await render(input);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}
