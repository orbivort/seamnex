import { Module } from '@nestjs/common';
import { OpenApiController } from './openapi.controller';

/**
 * The OpenAPI document only. The route table and the handler registry are wired in `AppModule`,
 * the single composition root: they need to see every domain module, and an imported module
 * cannot see its importer's providers (ADR-BE-03).
 */
@Module({ controllers: [OpenApiController] })
export class ContractModule {}
