-- Device.id becomes the primary key. The existing unique index on "id" is
-- reused, so Postgres renames it to "Device_pkey" without rebuilding it. The
-- column is already NOT NULL, so no table scan is needed.
ALTER TABLE "Device" ADD CONSTRAINT "Device_pkey" PRIMARY KEY USING INDEX "Device_id_key";
