import { Controller, Get, Header } from '@nestjs/common';
import { buildOpenApiDocument } from '@seamnex/domain';

/**
 * ADR-BE-01: the served document is the contract, not a copy of it.
 *
 * The document is generated once at boot from `API_OPERATIONS` and serialised exactly as the
 * golden-file test serialises it, so `GET /api/v1/openapi.json` and `docs/openapi.json` cannot
 * differ. Phase 1 adds no operation, so the bytes are identical to the committed file.
 */
@Controller()
export class OpenApiController {
  private readonly body = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

  @Get('openapi.json')
  @Header('content-type', 'application/json; charset=utf-8')
  document(): string {
    return this.body;
  }
}
