"""Generate browser-safe Desktop management contracts from the checked Core schemas."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]
GUI = ROOT / 'clients/gui'
DEST = GUI / 'packages/workbench/client/desktop-contract/generated'
SOURCE = ROOT / 'schemas/areal-core-v1.json'
SCHEMAS = json.loads(SOURCE.read_text())
RECURSIVE = {}
DOCUMENT_HASH = {}


# 桌面管理契约公开的字段投影。Host 独立执行准入与路由。
CORE_PROJECTIONS = {
    'pluginHooks': ('areal/plugin/hooks/list', []),
    'pluginMcp': ('areal/plugin/mcp/list', []),
    'plugins': ('areal/plugin/list', []),
    'plugin': ('areal/plugin/read', ['id']),
    'pluginComponents': ('areal/plugin/components', ['id']),
    'providers': ('areal/provider/list', []),
    'profile': ('areal/profile/read', ['id', 'revision']),
    'skills': ('areal/skill/list', ['threadId', 'agentProfile']),
    'skill': ('areal/skill/read', ['threadId', 'agentProfile', 'skill', 'resource', 'offset', 'maxBytes']),
    'inspect': ('areal/thread/inspect', ['threadId']),
    'context': ('areal/context/read', ['threadId', 'offset', 'limit']),
    'inheritedHistory': ('areal/conversation/history', ['threadId', 'view', 'cursor', 'maxBytes']),
    'plan': ('areal/plan/read', ['threadId']),
    'processes': ('areal/process/list', ['threadId']),
    'process': ('areal/process/get', ['threadId', 'id']),
    'processWait': ('areal/process/wait', ['threadId', 'id', 'timeoutMs']),
    'goal': ('areal/goal/get', ['threadId']),
    'permissions': ('areal/permissions/read', ['threadId']),
    'interactions': ('areal/interaction/list', ['threadId']),
    'processOutput': ('areal/process/read', ['threadId', 'id', 'after', 'maxBytes', 'waitMs']),
    'executionTraceResult': ('areal/execution/traceResult', ['threadId', 'executionId', 'workerThreadId', 'uri']),
    'executionTrace': ('areal/execution/trace', ['threadId', 'executionId', 'workerThreadId', 'cursor']),
    'executions': ('areal/execution/list', ['parentThreadId', 'offset', 'limit']),
    'execution': ('areal/execution/read', ['parentThreadId', 'executionId', 'offset']),
    'executionArtifact': ('areal/execution/artifact', ['parentThreadId', 'executionId', 'path', 'offset']),
    'executionWait': ('areal/execution/wait', ['parentThreadId', 'executionId', 'timeoutMs']),
    'agents': ('areal/agent/list', ['parentThreadId', 'cursor', 'limit']),
    'agentWait': ('areal/agent/wait', ['parentThreadId', 'threadIds', 'timeoutMs']),
    'workflows': ('areal/workflow/list', []),
    'server': ('areal/server/status', []),
    'workflow': ('areal/workflow/read', ['id', 'revision']),
    'workgroupPolicy': ('areal/workgroup/policy', []),
    'workgroups': ('areal/workgroup/list', []),
    'workgroup': ('areal/workgroup/read', ['id']),
    'workgroupWait': ('areal/workgroup/wait', ['id', 'afterRevision', 'timeoutMs']),
    'workgroupArtifact': ('areal/workgroup/artifact', ['id', 'path', 'offset']),
    'pluginArchiveImport': ('areal/plugin/importArchive', ['path', 'expectedRevision']),
    'pluginHooksConfigure': ('areal/plugin/hooks/configure', ['id', 'expectedDigest', 'definitionDigest', 'enabled', 'trusted', 'allowReadOnlyCommands']),
    'hookAcknowledge': ('areal/hook/acknowledge', ['threadId', 'invocationId', 'inspection']),
    'pluginAuthConfigure': ('areal/plugin/auth/configure', ['id', 'server', 'expectedDigest', 'configuration']),
    'pluginConnection': ('areal/plugin/connection', ['id', 'expectedDigest', 'connect']),
    'pluginComponentConfigure': ('areal/plugin/component/configure', ['id', 'component', 'enabled', 'expectedRevision', 'expectedDigest']),
    'pluginSetup': ('areal/plugin/setup', ['id', 'threadId']),
    'pluginUserConfigSave': ('areal/plugin/userConfig/set', ['id', 'expectedRevision', 'expectedDigest', 'values', 'clearKeys']),
    'pluginDevelopmentLink': ('areal/plugin/development/link', ['id', 'expectedRevision', 'expectedDigest']),
    'pluginDevelopmentUnlink': ('areal/plugin/development/unlink', ['id', 'expectedRevision']),
    'providerSave': ('areal/provider/upsert', ['provider', 'expectedRevision']),
    'providerRemove': ('areal/provider/remove', ['id', 'expectedRevision']),
    'archive': ('areal/thread/archive', ['threadId']),
    'unarchive': ('areal/conversation/unarchive', ['threadId']),
    'processCloseStdin': ('areal/process/closeStdin', ['threadId', 'id']),
    'processStart': ('areal/process/start', ['threadId', 'lifetime', 'argv', 'cwd', 'tty', 'cols', 'rows', 'timeoutMs']),
    'processWrite': ('areal/process/write', ['threadId', 'id', 'dataBase64']),
    'processResize': ('areal/process/resize', ['threadId', 'id', 'cols', 'rows']),
    'processTerminate': ('areal/process/terminate', ['threadId', 'id']),
    'goalCreate': ('areal/goal/create', ['threadId', 'expectedRevision', 'objective', 'tokenBudget', 'maxTurns', 'maxActiveSeconds', 'inferLimits']),
    'goalUpdate': ('areal/goal/update', ['threadId', 'expectedRevision', 'goalId', 'objective', 'tokenBudget', 'maxTurns', 'maxActiveSeconds', 'inferLimits']),
    'goalPause': ('areal/goal/pause', ['threadId', 'expectedRevision', 'goalId']),
    'goalResume': ('areal/goal/resume', ['threadId', 'expectedRevision', 'goalId']),
    'goalClear': ('areal/goal/clear', ['threadId', 'expectedRevision', 'goalId']),
    'pluginAuth': ('areal/plugin/auth', ['id', 'server', 'operation']),
    'mcpExtensionCall': ('areal/mcp/extension/call', ['threadId', 'serverId', 'expectedGeneration', 'kind', 'arguments', 'requestId']),
    'workgroupStart': ('areal/workgroup/start', ['plan', 'workers', 'admission']),
    'workflowStart': ('areal/workflow/start', ['workflow', 'workers', 'admission']),
    'workgroupRevise': ('areal/workgroup/revise', ['id', 'expectedRevision', 'plan']),
    'taskSchedulePreview': ('areal/task/schedule/preview', ['schedule', 'from', 'count']),
    'taskScheduleContext': ('areal/task/schedule/context', ['timeZone']),
    'tasks': ('areal/task/list', ['after', 'limit']),
    'task': ('areal/task/read', ['taskId']),
    'taskInbox': ('areal/inbox/list', ['after', 'limit']),
    'taskChannel': ('areal/channel/read', ['taskId', 'afterSequence', 'limit']),
    'taskRuns': ('areal/task/runs/list', ['taskId', 'cursor', 'limit']),
    'taskRun': ('areal/task/run/read', ['taskId', 'runId']),
    'taskCreate': ('areal/task/create', ['mode', 'objective', 'threadId', 'sourceThreadId', 'interactionMode', 'schedule', 'scheduleV2', 'tokenBudget', 'maxTurns', 'maxActiveSeconds', 'delivery', 'model', 'parameters']),
    'taskUpdate': ('areal/task/update', ['taskId', 'expectedRevision', 'objective', 'schedule', 'scheduleV2', 'delivery', 'model', 'parameters']),
    'taskRunNow': ('areal/task/runNow', ['taskId', 'expectedRevision']),
    'taskPause': ('areal/task/pause', ['taskId', 'expectedRevision']),
    'taskResume': ('areal/task/resume', ['taskId', 'expectedRevision']),
    'taskStopRun': ('areal/task/stopRun', ['taskId', 'expectedRevision', 'expectedRunId']),
    'taskResumeRun': ('areal/task/resumeRun', ['taskId', 'expectedRevision', 'expectedRunId']),
    'taskCancel': ('areal/task/cancel', ['taskId', 'expectedRevision']),
    'taskDelete': ('areal/task/delete', ['taskId', 'expectedRevision']),
    'taskReply': ('areal/channel/reply', ['taskId', 'runId', 'questionId', 'answers']),
    'executionCancel': ('areal/execution/cancel', ['parentThreadId', 'executionId', 'mode']),
    'executionApply': ('areal/execution/apply', ['parentThreadId', 'executionId']),
    'workgroupCancel': ('areal/workgroup/cancel', ['id']),
    'planUpdate': ('areal/plan/update', ['threadId', 'expectedRevision', 'steps']),
    'contextCompact': ('areal/context/compact', ['threadId']),
    'permissionsForget': ('areal/permissions/forget', ['threadId', 'project']),
    'providerProbe': ('areal/provider/probe', ['id', 'model']),
    'closeResources': ('areal/thread/closeResources', ['threadId']),
    'serverDrain': ('areal/server/drain', []),
    'serverGc': ('areal/server/gc', []),
    'agentSpawn': ('areal/agent/spawn', ['parentThreadId', 'agentProfile', 'model', 'instructions', 'skills', 'toolAllowlist']),
    'pluginAuthCredential': ('areal/plugin/auth/configure', ['id', 'server', 'expectedDigest', 'configuration']),
    'toolAcknowledge': ('areal/tool/acknowledge', ['threadId', 'itemId', 'inspection']),
}

def literal(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def name(value):
    return ''.join(part[:1].upper() + part[1:] for part in re.split(r'[^A-Za-z0-9]+', value))


def resolve(schema, document, trail=()):
    if isinstance(schema, bool):
        return schema
    if '$ref' in schema:
        ref = schema['$ref']
        token = DOCUMENT_HASH.setdefault(id(document), hashlib.sha256(literal(document).encode()).hexdigest()) + ref
        if ref in trail:
            return {'$recursive':token}
        target = document
        for part in ref.removeprefix('#/').split('/'):
            target = target[int(part)] if isinstance(target, list) else target[part.replace('~1', '/').replace('~0', '~')]
        result = resolve(target, document, (*trail, ref))
        RECURSIVE[token] = result
        return result
    result = {}
    for key, value in schema.items():
        if key in ('$defs', 'description', 'default', 'title', 'format', '$schema'):
            continue
        if key == 'properties':
            result[key] = {field: resolve(item, document, trail) for field, item in value.items()}
        elif key in ('items', 'additionalProperties', 'if', 'then', 'else', 'not') and isinstance(value, (dict, bool)):
            result[key] = resolve(value, document, trail)
        elif key in ('anyOf', 'oneOf', 'allOf'):
            result[key] = [resolve(item, document, trail) for item in value]
        else:
            result[key] = value
    return result


class Module:
    def __init__(self, domain):
        self.domain = domain
        self.definitions = {}
        self.names = set()
        self.outputs = []
        self.requests = {}
        self.responses = {}
        self.standalone_names = set()

    def shape(self, schema, hint):
        if isinstance(schema, dict) and '$recursive' in schema:
            return self.shape(RECURSIVE[schema['$recursive']], hint)
        complex_shape = isinstance(schema, dict) and (schema.get('type') == 'object' or any(key in schema for key in ('oneOf', 'anyOf', 'allOf')))
        if not complex_shape:
            return self.inline(schema, hint)
        key = literal(schema)
        if key in self.definitions:
            alias = self.definitions[key]
            return alias, f'is{alias}(VALUE)'
        alias = name(hint)
        suffix = 2
        while alias in self.names:
            alias = name(hint) + str(suffix)
            suffix += 1
        self.names.add(alias)
        self.definitions[key] = alias
        typ, check = self.inline(schema, hint)
        self.outputs.append(f'/** @typedef {{{typ}}} {alias} */\n/** @param {{unknown}} value @returns {{value is {alias}}} */\nfunction is{alias}(value) {{ return {check.replace("VALUE", "value")}; }}\n')
        return alias, f'is{alias}(VALUE)'

    def inline(self, schema, hint):
        if isinstance(schema, dict) and '$contextOwner' in schema:
            owner = schema['$contextOwner']
            if owner not in ('ContextUsage', 'SessionUsage'): raise ValueError('Unknown context owner')
            return 'import("../management-context.cjs").' + owner, 'require("../management-context.cjs").is' + owner + '(VALUE)'
        if isinstance(schema, dict) and '$mcpOwner' in schema:
            owner = schema['$mcpOwner']
            if owner not in ('McpToolMetadata', 'McpIcon', 'McpContentBlock'): raise ValueError('Unknown MCP owner')
            return 'import("../management-mcp.cjs").' + owner, 'require("../management-mcp.cjs").is' + owner + '(VALUE)'
        if schema is True or schema == {}:
            return 'unknown', 'true'
        if schema is False:
            return 'never', 'false'
        allowed = {'type','const','enum','properties','required','additionalProperties','items','oneOf','anyOf','allOf','minimum','maximum','minLength','maxLength','minItems','maxItems','uniqueItems','pattern','exclusiveMinimum','exclusiveMaximum','if','then','else','not'}
        unsupported = set(schema) - allowed
        if unsupported:
            raise ValueError(f'Unsupported schema keywords at {hint}: {unsupported}')
        for keyword in ('oneOf','anyOf','allOf'):
            if keyword in schema:
                parts = [self.shape(part, hint + 'Variant' + str(i + 1)) for i, part in enumerate(schema[keyword])]
                op = '&' if keyword == 'allOf' else '|'
                check = ' && ' if keyword == 'allOf' else ' || '
                typ = '(' + op.join(typ for typ, _ in parts) + ')'
                test = ('[' + ','.join('(' + test + ')' for _,test in parts) + '].filter(Boolean).length === 1') if keyword == 'oneOf' else '(' + check.join('(' + test + ')' for _, test in parts) + ')'
                base = {key:value for key,value in schema.items() if key != keyword}
                if base:
                    base_type,base_check = self.inline(base,hint+'Base')
                    return '('+base_type+'&'+typ+')','('+base_check+') && '+test
                return typ,test
        if 'if' in schema:
            base = {key:value for key,value in schema.items() if key not in ('if','then','else')}
            base_type,base_check = self.inline(base,hint+'Base')
            _,condition = self.inline(schema['if'],hint+'Condition')
            _,then_check = self.inline(schema.get('then',True),hint+'Then')
            _,else_check = self.inline(schema.get('else',True),hint+'Else')
            return base_type,'('+base_check+') && (('+condition+') ? ('+then_check+') : ('+else_check+'))'
        if 'not' in schema:
            _,test=self.inline(schema['not'],hint+'Not')
            return 'unknown','!('+test+')'
        if 'const' in schema:
            return literal(schema['const']), 'VALUE === ' + literal(schema['const'])
        if 'enum' in schema:
            return '|'.join(literal(x) for x in schema['enum']), '(' + ' || '.join('VALUE === ' + literal(x) for x in schema['enum']) + ')'
        typ = schema.get('type', 'object' if 'properties' in schema or 'required' in schema else None)
        if isinstance(typ, list):
            parts = [self.inline({**schema,'type':part},hint + name(part)) for part in typ]
            return '(' + '|'.join(t for t,_ in parts) + ')', '(' + ' || '.join('('+v+')' for _,v in parts) + ')'
        if typ == 'object':
            properties = schema.get('properties', {})
            required = schema.get('required', [])
            parts = {field:self.shape(item, hint + name(field)) for field,item in properties.items()}
            fields = [literal(field) + ('' if field in required else '?') + ':' + part[0] for field,part in parts.items()]
            fields += [literal(field) + ':unknown' for field in required if field not in properties]
            checks = ['modelRecord(VALUE)'] + ['Object.hasOwn(VALUE,'+literal(field)+')' for field in required if field not in properties or properties[field] in ({},True)]
            for field,(_,test) in parts.items():
                access = 'VALUE[' + literal(field) + ']'
                item = test.replace('VALUE',access)
                checks.append('(' + item + ')' if field in required else '(' + access + ' === undefined || (' + item + '))')
            extra = schema.get('additionalProperties', True)
            if extra is False:
                checks.append('Object.keys(VALUE).every((key) => ' + literal(list(properties)) + '.includes(key))' if properties else 'Object.keys(VALUE).length === 0')
            elif isinstance(extra, dict) and extra:
                item_type,item_check = self.shape(extra,hint+'Entry')
                fields.append('[key:string]:' + item_type)
                checks.append('Object.entries(VALUE).every(([key,item]) => '+(literal(list(properties))+'.includes(key) || ' if properties else '')+'('+item_check.replace('VALUE','item')+'))')
            if not properties and not required and extra is True: fields.append('[key:string]:unknown')
            return ('Record<string,never>' if not fields and extra is False else '{' + ','.join(fields) + '}'), ' && '.join(checks)
        if typ == 'array':
            item_type,item_check = self.shape(schema.get('items',{}),hint+'Item')
            checks = ['Array.isArray(VALUE)','VALUE.every((/** @type {unknown} */ item) => '+item_check.replace('VALUE','item')+')']
            for key,op in [('minItems','>='),('maxItems','<=')]:
                if key in schema: checks.append(f'VALUE.length {op} {schema[key]}')
            if schema.get('uniqueItems'):
                if schema.get('items') != {'type':'string'}: raise ValueError('Unowned non-string uniqueItems schema')
                checks.append('new Set(VALUE).size === VALUE.length')
            return '('+item_type+')[]',' && '.join(checks)
        checks=[]
        if typ == 'null':return 'null','VALUE === null'
        if typ in ('integer','number'):
            checks=['typeof VALUE === "number"', 'Number.isSafeInteger(VALUE)' if typ == 'integer' else 'Number.isFinite(VALUE)']
            for key,op in [('minimum','>='),('maximum','<='),('exclusiveMinimum','>'),('exclusiveMaximum','<')]:
                if key in schema:checks.append(f'VALUE {op} {schema[key]}')
            return 'number',' && '.join(checks)
        if typ == 'string':
            checks=['typeof VALUE === "string"']
            for key,op in [('minLength','>='),('maxLength','<=')]:
                if key in schema:checks.append(f'VALUE.length {op} {schema[key]}')
            if 'pattern' in schema:checks.append('new RegExp('+literal(schema['pattern'])+').test(VALUE)')
            return 'string',' && '.join(checks)
        if typ == 'boolean':return 'boolean','typeof VALUE === "boolean"'
        if typ is None:return 'unknown','true'
        raise ValueError(f'Unsupported type {typ}')

    def add(self, operation, method, fields):
        req = resolve(SCHEMAS['requests'][method], SCHEMAS['requests'][method])
        res = resolve(SCHEMAS['responses'][method], SCHEMAS['responses'][method])
        if req.get('type') != 'object':
            raise ValueError(f'Non-object management request: {operation}')
        req['properties'] = {key:value for key,value in req.get('properties',{}).items() if key in fields or key == 'requestId'}
        req['required'] = [key for key in req.get('required',[]) if key in req['properties'] and key != 'requestId']
        req['properties']['operation'] = {'const': operation}
        req['properties']['projectId'] = {'type':'string'}
        req['required'] += ['operation','projectId']
        req['additionalProperties'] = True
        if operation == 'mcpExtensionCall':
            # mcp_apps.rs forwards the original validated MCP result content.
            res['properties']['content']['items'] = {'$mcpOwner':'McpContentBlock'}
        if operation in ('skills','skill'):
            # core/app-server/src/desktop.rs:83-99,833-858: exactly one owner.
            version = resolve(SCHEMAS['requests']['areal/skill/read'],SCHEMAS['requests']['areal/skill/read'])['properties']['skill']
            req['properties']['agentProfile'] = version
            req['required'] = [key for key in req['required'] if key != 'threadId']
            req['oneOf'] = [
                {'type':'object','properties':{'threadId':{'type':'string'},'agentProfile':False},'required':['threadId']},
                {'type':'object','properties':{'threadId':False,'agentProfile':version},'required':['agentProfile']},
            ]
        if operation == 'skills':
            # catalog.rs:827 profile_skills returns data; skills_for_turn also returns loaded.
            res['required'] = [key for key in res['required'] if key != 'loaded']
        if operation in ('context','contextCompact'):
            # context.rs:72-74 and history.rs:748 normalize calls, omitting provider-private bodies.
            res['properties']['data']['items']['properties']['toolCalls']['items'] = {'type':'object','properties':{'id':{'type':'string'},'type':{'const':'function'},'function':{'type':'object','properties':{'name':{'type':'string'},'arguments':{'type':'string'}},'required':['name','arguments']},'_responsesItem':True},'required':['id','type','function']}
            res['properties']['contextUsage'] = {'$contextOwner':'ContextUsage'}
            res['properties']['sessionUsage'] = {'$contextOwner':'SessionUsage'}
            res['required'] += ['contextUsage','sessionUsage']
            # serde defaults are accepted on input, but serialized fields are always present.
            checkpoint = res['properties']['checkpoint']['anyOf'][0]
            checkpoint['required'] += ['totalDurationMs','usage']
            checkpoint['properties']['usage']['required'] += ['cachedInputTokens']
            res['properties']['budget']['anyOf'][0]['properties']['windowSource'] = {'enum':['account','provider','user','modelDefault','fallback']}
        if operation in ('plan','planUpdate'):
            # core/engine/src/desktop/state.rs:1022 checks this finite state set.
            steps = req['properties'].get('steps') if operation == 'planUpdate' else None
            for schema in [res['properties']['steps'],steps]:
                if schema: schema['items']['properties']['status'] = {'enum':['pending','inProgress','completed','cancelled']}
        if operation == 'executionArtifact':
            # delegation.rs:1124 returns a settled identity projection while artifact is unavailable.
            execution = resolve(SCHEMAS['responses']['areal/execution/read'],SCHEMAS['responses']['areal/execution/read'])
            for key in ['owner','parentThreadId','threadId','turnId']:
                execution['properties'].pop(key,None)
                execution['required'] = [field for field in execution['required'] if field != key]
            execution['properties']['receiptVersion'] = {'type':'string'}
            execution['required'].append('receiptVersion')
            res['oneOf'].append({'type':'object','properties':{'ready':{'const':False},'execution':execution,'nextAction':{'type':'string'}},'required':['ready','execution','nextAction']})
        if operation == 'agentSpawn':
            res=next(part for part in res['oneOf'] if 'threadId' in part.get('properties',{}))
            req['properties']['prompt']={'type':'string'}
            req['required'].append('prompt')
        if operation == 'pluginAuthCredential':
            req['properties']['credentials']={'type':'object','properties':{key:{'type':'string'} for key in ['clientSecret','privateKeyPem','apiKey']},'additionalProperties':False}
        if operation in ('toolAcknowledge','providerRemove'):
            # management.cjs toolAcknowledge and desktop.rs:921 providerRemove return exactly {}.
            res={'type':'object','additionalProperties':False}
        if operation == 'pluginArchiveImport':
            req['properties']['selectionToken']={'type':'string'}
            req['required']=[key for key in req['required'] if key != 'path']
            req['anyOf']=[{'required':['path']},{'required':['selectionToken']}]
        if operation == 'pluginAuth':
            req['properties']['authOperation'] = {'enum':['start','status','cancel']}
            req['required'] += ['authOperation']
        if operation == 'processStart':
            req['properties']['terminal'] = {'type':'boolean'}
            req['properties']['guiOwned'] = {'type':'boolean'}
            req['required'] = [key for key in req['required'] if key != 'argv']
        if operation in ('workgroup','workgroupWait','workgroupStart','workflowStart','workgroupRevise','workgroupCancel'):
            kept=['id','record','historyCount','verificationCount']
            res['properties']={key:value for key,value in res['properties'].items() if key in kept}
            res['required']=[key for key in res['required'] if key in kept]
        if operation == 'taskReply':
            res['properties']['questionId']={'type':'string'}
            res['required'].append('questionId')
        if operation == 'processStart':
            res['properties'].update({'shell':{'type':'string'},'fontFamily':{'type':'string'},'fontSize':{'type':'number'},'theme':{'type':'object','additionalProperties':{'type':'string'}},'fontFamilySource':{'enum':['custom','system','fallback']}})
        if operation in ('agentSpawn','agentWait'):
            # desktop/agents.rs:179,224,385 projects known configuration and isolated results.
            version = resolve(SCHEMAS['requests']['areal/skill/read'],SCHEMAS['requests']['areal/skill/read'])['properties']['skill']
            configuration = {'type':'object','properties':{'revision':{'type':'integer','minimum':0},'profile':{'anyOf':[version,{'type':'null'}]},'model':{'anyOf':[{'type':'object','properties':{'providerId':{'type':'string'},'modelId':{'type':'string'}},'required':['providerId','modelId']},{'type':'null'}]},'readOnly':{'type':'boolean'}},'required':['revision','profile','model','readOnly']}
            if operation == 'agentSpawn': res['properties']['configuration']={'anyOf':[configuration,{'type':'null'}]}
            else:
                variants=res['properties']['data']['items']['oneOf']
                variants[0]['properties']['configuration']={'anyOf':[configuration,{'type':'null'}]}
                variants[1]['properties']['result']={'type':'object','properties':{'id':{'type':'string'},'revision':{'type':'integer','minimum':0},'status':{'type':'string'},'head':{'type':'string'},'cleanupConfirmed':{'type':['boolean','null']},'detailsAvailable':{'const':True}},'required':['id','revision','status','head','cleanupConfirmed','detailsAvailable']}
        self.requests[operation]=self.shape(req,name(operation)+'Request')[0]
        self.responses[operation]=self.shape(res,name(operation)+'Response')[0]

    def emit(self):
        lines=['// @ts-check','"use strict";',f'// Generated by scripts/generate-management-contracts.py from schemas/areal-core-v1.json.','const { modelRecord } = require("../../core-model-contract.js");','']+self.outputs
        lines += ['/** @typedef {{'+','.join(literal(k)+':'+v for k,v in self.requests.items())+'}} RequestMap */','/** @typedef {{'+','.join(literal(k)+':'+v for k,v in self.responses.items())+'}} ResponseMap */','const requests = {'+','.join(literal(k)+':is'+v for k,v in self.requests.items())+'};','const responses = {'+','.join(literal(k)+':is'+v for k,v in self.responses.items())+'};']
        roots=set(self.requests.values())|set(self.responses.values())|self.standalone_names
        lines += ['module.exports = { requests, responses, '+', '.join('is'+v for v in sorted(roots))+' };','']
        return '\n'.join(lines)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check',action='store_true');args=parser.parse_args()
    groups={}
    for op,(method,fields) in CORE_PROJECTIONS.items():
        domain=('plugin-setup' if op == 'pluginSetup' else 'tasks' if method.startswith(('areal/task/','areal/channel/','areal/inbox/')) else 'plugins' if method.startswith(('areal/plugin/','areal/marketplace/','areal/hook/')) else 'mcp' if method.startswith('areal/mcp/') else 'workgroups' if method.startswith(('areal/workgroup/','areal/workflow/')) else 'processes' if method.startswith('areal/process/') else 'agents' if method.startswith('areal/agent/') else 'execution' if method.startswith('areal/execution/') else 'configuration' if method.startswith(('areal/provider/','areal/profile/','areal/skill/')) else 'thread')
        groups.setdefault(domain,Module(domain)).add(op,method,fields)
    owner = Module('owner-directory')
    page = SCHEMAS['responses']['areal/task/directory/list']
    page = resolve(page, page)
    attention = SCHEMAS['responses']['areal/task/attention/read']
    attention = resolve(attention, attention)
    event = SCHEMAS['notifications']['areal/owner/invalidated']
    event = resolve(event, event)
    row = page['properties']['data']['items']
    run = next(item for item in row['properties']['latestRun']['anyOf'] if item.get('type') != 'null')
    standalone = {
        'RunDirectoryRow': run,
        'TaskDirectoryRow': row,
        'OwnerAttention': attention['properties']['data']['items'],
        'OwnerNoticeFact': event['properties']['facts']['items'],
        'OwnerInvalidation': event,
        'TaskDirectoryPage': page,
        'OwnerAttentionPage': attention,
    }
    for alias, method in [('OwnerWatch', 'areal/owner/watch'), ('TaskDirectoryRows', 'areal/task/directory/read')]:
        document = SCHEMAS['responses'][method]
        standalone[alias] = resolve(document, document)
    for alias, document in standalone.items():
        owner.standalone_names.add(owner.shape(document, alias)[0])
    groups['owner-directory'] = owner
    outputs={f'management-{domain}-protocol.cjs':module.emit() for domain,module in groups.items()}
    index=['// @ts-check','"use strict";','// Generated from the management projections and checked Core schemas.']
    for kind in ['RequestMap','ResponseMap']:
        index.append('/** @typedef {'+'&'.join('import("./management-'+domain+'-protocol.cjs").'+kind for domain, module in groups.items() if module.requests)+'} '+kind+' */')
    index.append('/** @param {string} operation */')
    index.append('function protocolFor(operation) {')
    for domain,module in groups.items():
        if not module.requests: continue
        index.append('  if ('+literal(list(module.requests))+'.includes(operation)) return require("./management-'+domain+'-protocol.cjs");')
    index += ['  return null;','}','module.exports = { protocolFor };','']
    outputs['management-protocol.cjs']='\n'.join(index)
    if not args.check: DEST.mkdir(parents=True, exist_ok=True)
    changed=[]
    for filename,content in outputs.items():
        target=DEST/filename
        if not target.exists() or target.read_text()!=content:
            changed.append(filename)
            if not args.check:target.write_text(content)
    print(json.dumps({'sourceSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'operations':len(CORE_PROJECTIONS),'files':{key:len(value.splitlines()) for key,value in outputs.items()},'changed':changed},indent=2))
    if args.check and changed:raise SystemExit(1)

if __name__=='__main__':main()
