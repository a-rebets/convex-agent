import { httpRouter } from "convex/server";
import { streamOverHttp } from "./chat/streaming";
import { corsRouter } from "convex-helpers/server/cors";

const http = httpRouter();

const cors = corsRouter(http, {
  allowCredentials: true,
  allowedHeaders: ["Authorization", "Content-Type"],
  exposedHeaders: ["Content-Type", "Content-Length", "X-Message-Id"],
});

cors.route({
  path: "/streamText",
  method: "POST",
  handler: streamOverHttp,
});

// Convex expects the router to be the default export of `convex/http.js`.
export default http;
