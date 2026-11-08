import { handle } from "../src/doh.js";

// Catch-all so a secret ECH_PATH works on Pages too; routing is done inside handle().
export const onRequest = ({ request, env, waitUntil }) => handle(request, env, { waitUntil });
