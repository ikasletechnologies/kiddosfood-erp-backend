import "dotenv/config";
import { defineConfig, env } from "@prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DIRECT_URL"),
    directUrl: env("DIRECT_URL"),
  },
  migrations: {
    seed: "node --import tsx prisma/seed.ts",
  },
});

