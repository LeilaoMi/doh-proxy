import { handle } from "../src/doh.js";

export const onRequest = ({ request, env, waitUntil }) => handle(request, env, { waitUntil });
