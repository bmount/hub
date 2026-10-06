import { registerVerbs } from "./table";
import { bootstrap } from "./bootstrap";
import { whoami } from "./whoami";
import { tenantArchive, tenantCreate, tenantList, tenantUnarchive } from "./tenant";
import { namespaceArchive, namespaceCreate, namespaceUnarchive } from "./namespace";
import { projectArchive, projectCreate, projectList, projectUnarchive } from "./project";
import { inviteCreate, inviteList, inviteRevoke } from "./invite";

export function registerAllVerbs(): void {
  registerVerbs([
    bootstrap, whoami,
    tenantCreate, tenantArchive, tenantUnarchive, tenantList,
    namespaceCreate, namespaceArchive, namespaceUnarchive,
    projectCreate, projectArchive, projectUnarchive, projectList,
    inviteCreate, inviteRevoke, inviteList,
  ]);
}
