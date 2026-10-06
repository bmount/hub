import { registerVerbs } from "./table";
import { bootstrap } from "./bootstrap";
import { whoami } from "./whoami";

export function registerAllVerbs(): void {
  registerVerbs([bootstrap, whoami]);
}
