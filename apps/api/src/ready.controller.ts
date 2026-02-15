import { Controller, Get, Inject, ServiceUnavailableException, HttpException } from "@nestjs/common";
import { ReadyService } from "./ready.service";

@Controller("/ready")
export class ReadyController {
  constructor(@Inject(ReadyService) private readonly ready: ReadyService) {}
  @Get()
  async getReady() {
    try {
      const res = await this.ready.check();
      if (!res.ok) throw new ServiceUnavailableException(res);
      return res;

    } catch (e: any) {
      if (e instanceof HttpException) throw e;
      throw new ServiceUnavailableException({
        ok: false,
        ts: new Date().toISOString(),
        error: e?.message ?? String(e),
        stack: e?.stack ?? undefined,
      });
    }
  }
}
