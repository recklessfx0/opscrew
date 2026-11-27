/** IONOS Cloud as an OpsCrew cloud server provider (ADR 0029). */
export { IonosCatalog } from "./catalog";
export {
  IONOS_API_URL,
  IONOS_CREDENTIALS_HINT,
  IONOS_ENV,
  IonosClient,
  readIonosCredentials,
} from "./client";
export { IONOS_CREDENTIALS, type IonosConnector, ionosConnector } from "./connector";
export { definition } from "./definition";
export { ionosServerApi } from "./servers";
export {
  HOURS_A_MONTH,
  IONOS_LOCATIONS,
  STATIC_PRICES_AS_OF,
  STATIC_RATES,
  STATIC_SIZES,
  TRAFFIC_INCLUDED_GB_A_MONTH,
} from "./static-prices";
