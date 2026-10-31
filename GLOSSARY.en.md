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

**Reuse Conversation**:
A mode in which a Schedule initiates subsequent work in the same conversation bound when the Schedule was created, continuing with the latest conversation context at execution time.
_Avoid_: following the conversation currently open in the interface; a history snapshot from Schedule creation; creating a new conversation for each execution

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

**Execution Trace**:
A retained record of processing across turns, including model calls, tool operations and associated delegated agent tasks, used to inspect the work performed and its execution state.
_Avoid_: Assistant replies alone; treating Side Chat or Fork as delegated agent tasks

**Turn Elapsed Time**:
The time that passes from the actual start of turn execution to its terminal outcome, or from execution start to the present while it is still running. Queue waiting before execution starts is measured separately.
_Avoid_: The sum of parallel tool or subagent durations; model generation time alone

**Subagent Lifetime Duration**:
The time that actually passes from the start of a delegated agent task's execution to its terminal outcome, which may span multiple parent turns.
_Avoid_: Parent turn elapsed time; the duration of one operation waiting for the subagent

**Pause Execution**:
A temporary stop in advancing unfinished work in a main conversation, retaining its objective, existing progress and intent to continue later.
_Avoid_: Abandoning the objective, undoing completed work, freezing an exact execution position

**Continue Execution**:
An explicit user action to continue unfinished work in the original main conversation using its retained objective, progress and current conditions.
_Avoid_: Creating a new conversation, starting over, automatically replaying old tool calls

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

**Host**: The computer that holds projects and the actual execution environment and accepts remote observation/control.

_Avoid_: Equating the Host with a closable GUI window

**Core**: The business system that owns sessions, model work, task coordination and execution history.

_Avoid_: Assigning Core task decisions to a Relay or execution backend

**Runtime**: The system that performs operations and manages execution resources within defined permission boundaries.

_Avoid_: Conflating Runtime with the model work loop

**Project**: A registered working context on a Host used to organize sessions and grant device access.

_Avoid_: Treating project selection as access to the entire computer

**Session / Thread**: Continuous work accumulating interactions and execution history in one context; Session is the product term for the Thread domain object.

_Avoid_: Creating a separate mobile session unrelated to the original Thread

**Task**: A persistent work arrangement with an objective, scheduling and cross-execution constraints that can produce multiple TaskRuns.

_Avoid_: Calling every overview card a new Task object

**TaskRun**: One concrete execution of a Task, including coordination and its workers.

_Avoid_: Treating a coordinator Turn ending as completion of the entire Run

**WorkItem**: An overview entry representing a regular Session or a TaskRun.

_Avoid_: Treating it as another independently scheduled task

**AttentionItem**: An approval, question, unconfirmed submission or other issue requiring user attention.

_Avoid_: Assuming that every attention item means execution has stopped

**Remote Gateway**: The Host entry that accepts device requests, enforces their access scope and exposes remote work views.

_Avoid_: Treating it as a generic terminal or another execution engine

**Relay**: An optional service providing a data route between remote devices and a Host.

_Avoid_: Equating Relay availability with Host availability or treating it as an approver

**Pairing Invitation**: A short-lived, one-use Host invitation to request device trust.

_Avoid_: Equating invitation possession with control permission

**DeviceGrant**: Explicit Host permission for a paired device to access projects and perform remote actions.

_Avoid_: Treating network login as project execution authority

**Command**: One user operation intent against a definite target; transmission retries remain the same intent.

_Avoid_: Treating every packet as a new user action

**Receipt**: Confirmation concerning admission or handling of an operation, distinct from later work settlement.

_Avoid_: Treating acceptance as successful completion

**UNKNOWN execution**: A state where available facts cannot confirm an execution outcome and inspection is required.

_Avoid_: Equating UNKNOWN with failure, no effect or permission to replay

**Result Review**: Read-only inspection of outputs, changes and artifacts to assess whether work meets requirements.

_Avoid_: Conflating review with tool approval, Git merge or execution permission
