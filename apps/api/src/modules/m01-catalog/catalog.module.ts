import { Module } from '@nestjs/common';
import { CatalogRepositoryModule } from '../m22-catalog-repository/catalog-repo.module';
import { CATALOG_SERVICE } from './catalog.contract';
import { PostgresCatalogService } from './catalog.service';

/**
 * The repository adapter is M22's, and the edge is declared here: a module may only *import*
 * another module's contract file (ADR-BE-03), and Nest's own import is the composition edge that
 * makes the provider resolvable. It used to be global, which meant this module's central
 * dependency appeared nowhere in the graph.
 */
@Module({
  imports: [CatalogRepositoryModule],
  providers: [{ provide: CATALOG_SERVICE, useClass: PostgresCatalogService }],
  exports: [CATALOG_SERVICE],
})
export class CatalogModule {}
