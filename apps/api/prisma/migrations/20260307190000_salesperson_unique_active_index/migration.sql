CREATE UNIQUE INDEX "salespersons_tenant_id_graph_user_id_key" ON "salespersons"("tenant_id", "graph_user_id");

CREATE INDEX "salespersons_tenant_id_active_idx" ON "salespersons"("tenant_id", "active");
