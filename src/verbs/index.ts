import { registerVerbs } from "./table";
import { plannedVerbs } from "./planned";
import { bootstrap } from "./bootstrap";
import { whoami } from "./whoami";
import { tenantArchive, tenantCreate, tenantDelete, tenantList, tenantUnarchive } from "./tenant";
import { mailList, mailProposeWork, mailRead, mailRelease } from "./mail";
import { workClaim, workCreate, workLink, workList, workRead, workUpdate } from "./work";
import { capabilities, projectHistory, skillList, skillRead } from "./discover";
import { modelRouteSet, modelTest, providerKeyAdd, providerKeyPromote, providerKeyRetire, providerKeyVerify, providerStatus } from "./models";
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
import { chatCatchup } from "./chatCatchup";
import { chatHistory, chatInbox, chatMarkRead, chatRead, chatThread, inboxAck, inboxWait, refBacklinks } from "./chatRead";
import { chatEdit, chatPost, chatRetract } from "./chatWrite";
import { chatAgentMute, chatAgentUnmute, chatAgentsDisable, chatAgentsEnable, chatConversations } from "./chatControl";

export function registerAllVerbs(): void {
  registerVerbs([
    bootstrap, whoami,
    tenantCreate, tenantArchive, tenantUnarchive, tenantList, tenantDelete,
    mailList, mailRead, mailRelease, mailProposeWork,
    workCreate, workList, workRead, workUpdate, workClaim, workLink,
    ...plannedVerbs,
    skillList, skillRead, capabilities, projectHistory,
    providerStatus, providerKeyAdd, providerKeyPromote, providerKeyRetire, providerKeyVerify, modelRouteSet, modelTest,
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
    chatPost, chatEdit, chatRetract,
    chatRead, chatThread, chatHistory, chatInbox, inboxWait, inboxAck, chatMarkRead, refBacklinks,
    chatConversations, chatCatchup, chatAgentMute, chatAgentUnmute, chatAgentsDisable, chatAgentsEnable,
  ]);
}
