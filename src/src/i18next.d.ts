import "i18next";
import type { resources } from "./locales/resources";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: (typeof resources)["zh-CN"];
    returnNull: false;
  }
}
