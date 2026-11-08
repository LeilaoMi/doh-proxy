import { handle } from "./src/doh.js";

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
};
