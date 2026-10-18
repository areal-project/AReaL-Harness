[中文](GLOSSARY.md) | **English**

# AReaL Harness product vocabulary

This glossary defines the shared language for AReaL Harness user interfaces. It does not imply that planned interfaces are implemented.

## Language

**Schedule**:
An arrangement made by the user to initiate specified work at specified times, once or repeatedly.
_Avoid_: foreground or background execution mode; an execution that has already started; the conversation itself

**Scheduled Run**:
One execution of work initiated by a Schedule, together with its result. Each execution of the same Schedule can be inspected separately.
_Avoid_: the Schedule itself; one model call

**AReaL client (Client)**:
A user entry point to AReaL Harness sessions and execution capabilities; desktop, mobile, TUI and CLI are peers.
_Avoid_: Equating a client with the execution engine, or treating mobile as a subordinate desktop product

**Desktop client (GUI)**:
The complete AReaL graphical application used on a computer, including its interface and required desktop capabilities.
_Avoid_: Calling only interface components or page source a complete desktop client

**Shared Browser**:
An environment in which a user and agent alternate control, observation and feedback over the same live pages.
_Avoid_: a separate automation browser; another page with the same URL

**Browser Workspace**:
A Thread-owned group of Browser Pages and their browsing context, forming the resource scope of shared browser work.
_Avoid_: code Workspace; AReaL Task; a direct alias of Ego Task Space

**Browser Page**:
One live page that can be claimed, observed and handed off. Its tab is a presentation of that page.
_Avoid_: the globally active tab; URL as identity

**Page Origin**:
Whether a page was created by a human, an agent or an unknown source; distinct from a network origin.
_Avoid_: creator equals current controller; website origin

**Browser Host**:
The trusted desktop host providing controlled browser capabilities to Core.
_Avoid_: page script; a second agent harness

**Browser Controller**:
The native resource owner of live Browser Pages and their control transitions.
_Avoid_: React Store; conversation-history owner

**Claim**:
An authorized inclusion of an existing human page in the current Thread’s agent-controllable scope.
_Avoid_: copying a page; reading every user tab

**Human Takeover**:
A user taking interaction control while pausing agent input and observation of that Browser Workspace.
_Avoid_: only stopping clicks; pausing the entire Core service

**Resume Control**:
An explicit user decision allowing the agent to use the current Browser Workspace after observing it again.
_Avoid_: automatic retry; reusing old coordinates

**Control Epoch**:
The version of one continuous browser-control authorization; actions after a handoff belong to a new epoch.
_Avoid_: connection generation; page load count

**Browser Observation**:
One semantic or visual observation tied to known Page, document and viewport conditions.
_Avoid_: instructions from a page; permanent page truth

**Element Ref**:
A short reference from a valid observation to an element identity within a particular document.
_Avoid_: a guessed selector; a permanent DOM ID

**Prepared Action**:
A concrete browser action prepared from live page facts for Core approval and validation.
_Avoid_: model intent alone; indefinitely reusable authorization

**Action Receipt**:
Execution evidence indicating non-dispatch, confirmed completion or an unconfirmed outcome for one browser action.
_Avoid_: business acceptance; a promise of rollback

**Browser Annotation**:
User feedback attached to a page element or captured region with provenance.
_Avoid_: agent permission; a code patch

**Style Preview**:
A reversible temporary appearance or text change for comparison, not a source-code change.
_Avoid_: saved code; a permanent website change

**Browser Evidence**:
Retrievable observations and verification materials associated with a Thread and related operations.
_Avoid_: the live page itself; a public sharing URL

**Browser Verification**:
A judgment of behavior or visual output grounded in explicit checks and browser evidence.
_Avoid_: a successful click; the model claiming completion

**Transient Browser Context**:
The cookie and site-storage container for the lifetime of a Browser Workspace.
_Avoid_: persistent Profile; OS sandbox

**Browser Profile**:
A user browsing identity and login profile retained across Browser Workspaces or desktop restarts.
_Avoid_: Agent Profile; transient context

**Main Conversation**:
A continuous conversation used to advance a user's primary task. A conversation created by a Fork is also a main conversation.
_Avoid_: Every chat panel, an active task only

**Turn**:
An accepted user input and the resulting processing episode, including replies, tool interactions and its terminal outcome. A turn may contain multiple messages.
_Avoid_: Message, single model request, display index

**Source Conversation**:
The conversation whose content a fork or side discussion draws from. This is a provenance relationship, not delegation.
_Avoid_: Parent agent, coordinating task owner

**Conversation Origin**:
A traceable relationship between a derived conversation, its source and the selected source position.
_Avoid_: Delegation relationship, inherited authorization

**Fork**:
An operation creating an independent main conversation from a selected turn boundary in a source conversation.
_Avoid_: Undo, file rollback, tool replay, copying the visible screen

**Before Turn**:
The position immediately before a selected turn starts. Its input and subsequent content are outside the inherited range.
_Avoid_: Rerun, retaining the selected input but dropping its answer

**After Turn**:
The position immediately after a selected turn ends. That turn and the preceding conversation belong to the inherited range.
_Avoid_: The current streaming tail, an arbitrary position before a reply

**Side Chat**:
An independent, user-initiated discussion about a main conversation for understanding, reviewing and exploring its content. It does not direct execution of the primary task.
_Avoid_: Subagent, main-conversation queue, second writable executor

**Source Anchor**:
The source position defining where a derived conversation's historical basis ends.
_Avoid_: The latest content, a UI array index

**Observation Snapshot**:
A preserved view of conversation evidence at a defined observation point, unaffected by subsequent source changes.
_Avoid_: Filesystem snapshot, live mutable state

**Inherited History**:
The existing conversation prefix used by a Fork to continue a discussion. It describes prior work rather than work newly executed by the fork.
_Avoid_: New execution records, new samples, new tool results

**Reference Evidence**:
Source content and verifiable provenance used to inform a side discussion.
_Avoid_: Pending commands, current permissions, live file versions

**Current Workspace**:
The project file environment being used now. Its time view is distinct from file observations recorded in conversation history.
_Avoid_: Files at the fork anchor, automatically isolated workspace

**Bring-back Draft**:
The user action of placing selected side-chat conclusions into the source conversation's unsent content.
_Avoid_: Automatic submission, automatic steering, branch merge

**Archived Conversation**:
A conversation removed from routine work views while its content remains retained and recoverable.
_Avoid_: Deletion, erasing all copies, stopping an active task

**Delegated Agent Task**:
Work assigned by a primary executor to another agent with coordination and lifecycle constraints.
_Avoid_: User-initiated side chat, fork
