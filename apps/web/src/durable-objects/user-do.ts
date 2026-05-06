import { DurableObject } from "cloudflare:workers";
import schemaSql from "./user-do.sql?raw";

export class UserDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.migrate();
      return Promise.resolve();
    });
  }

  private migrate(): void {
    const statements = schemaSql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      this.ctx.storage.sql.exec(stmt);
    }
  }

  fetch(request: Request): Promise<Response> {
    return Promise.resolve(
      new Response(`not implemented: ${request.url}`, { status: 501 }),
    );
  }
}
