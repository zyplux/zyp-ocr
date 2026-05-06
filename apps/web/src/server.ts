import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

export { UserDO } from "./durable-objects/user-do";

const startHandler = createStartHandler({ handler: defaultStreamHandler });

export default {
  fetch: startHandler,
} as ExportedHandler<Env>;
