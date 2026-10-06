import { registerVerbs } from "./table";
import { bootstrap } from "./bootstrap";
import { whoami } from "./whoami";
import { tenantArchive, tenantCreate, tenantList, tenantUnarchive } from "./tenant";
import { namespaceArchive, namespaceCreate, namespaceUnarchive } from "./namespace";
import { projectArchive, projectCreate, projectList, projectUnarchive } from "./project";
import { sessionEnd, sessionGit, sessionList, sessionRevoke, sessionStart } from "./session";
import { loginRequest, loginVerify } from "./login";
import { inviteCreate, inviteList, inviteRevoke } from "./invite";
import { agentArchive, agentCreate } from "./agent";
import { tokenCreate, tokenList, tokenRevoke } from "./token";
import { consentList, consentRevoke } from "./consent";
import { eventList } from "./event";
import { oauthGrantApprove } from "./oauth";
import {
  channelAddAgent, channelArchive, channelCreate, channelRemoveAgent, channelSetAgentPolicy, channelSetTopic, channelUnarchive,
} from "./channel";
import { chatAgentMute, chatAgentUnmute, chatAgentsDisable, chatAgentsEnable, chatConversations } from "./chatControl";

export function registerAllVerbs(): void {
  registerVerbs([
    bootstrap, whoami,
    tenantCreate, tenantArchive, tenantUnarchive, tenantList,
    namespaceCreate, namespaceArchive, namespaceUnarchive,
    projectCreate, projectArchive, projectUnarchive, projectList,
    inviteCreate, inviteRevoke, inviteList,
    sessionList, sessionRevoke, sessionEnd, sessionStart, sessionGit,
    loginRequest, loginVerify,
    consentList, consentRevoke,
    agentCreate, agentArchive,
    tokenCreate, tokenRevoke, tokenList,
    eventList,
    oauthGrantApprove,
    channelCreate, channelSetTopic, channelAddAgent, channelRemoveAgent, channelSetAgentPolicy, channelArchive, channelUnarchive,
    chatConversations, chatAgentMute, chatAgentUnmute, chatAgentsDisable, chatAgentsEnable,
  ]);
}
