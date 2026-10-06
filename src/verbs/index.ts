import { registerVerbs } from "./table";
import { bootstrap } from "./bootstrap";
import { whoami } from "./whoami";
import { tenantArchive, tenantCreate, tenantList, tenantUnarchive } from "./tenant";
import { namespaceArchive, namespaceCreate, namespaceUnarchive } from "./namespace";
import { projectArchive, projectCreate, projectList, projectUnarchive } from "./project";
import { sessionEnd, sessionList, sessionRevoke, sessionStart } from "./session";
import { loginRequest, loginVerify } from "./login";
import { inviteCreate, inviteList, inviteRevoke } from "./invite";
import { agentArchive, agentCreate } from "./agent";
import { tokenCreate, tokenList, tokenRevoke } from "./token";
import { consentList, consentRevoke } from "./consent";

export function registerAllVerbs(): void {
  registerVerbs([
    bootstrap, whoami,
    tenantCreate, tenantArchive, tenantUnarchive, tenantList,
    namespaceCreate, namespaceArchive, namespaceUnarchive,
    projectCreate, projectArchive, projectUnarchive, projectList,
    inviteCreate, inviteRevoke, inviteList,
    sessionList, sessionRevoke, sessionEnd, sessionStart,
    loginRequest, loginVerify,
    consentList, consentRevoke,
    agentCreate, agentArchive,
    tokenCreate, tokenRevoke, tokenList,
  ]);
}
