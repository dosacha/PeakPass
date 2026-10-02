import { randomUUID } from 'crypto';
import { withRedis } from './client';
import { admissionProfile, AdmissionOutcome } from '@/core/models/admission';

export interface RedisAdmissionEntry {
  admissionId: string;
  userId: string;
  epoch: string;
  sequence: string;
  state: 'waiting' | 'admitted' | 'consumed' | 'cancelled' | 'expired';
  phase: 'idle' | 'processing' | 'reconciling';
  joinedAt: number;
  admittedAt: number | null;
  expiresAt: number | null;
  reason: string | null;
  outcome: AdmissionOutcome | null;
  position?: number | null;
  fingerprint?: string;
  claimToken?: string;
  deadline?: number;
}
export interface RedisAdmissionResult {
  ok: boolean;
  status?: number;
  code?: string;
  wait?: number;
  now: number;
  epoch: string;
  entry?: RedisAdmissionEntry;
  created?: boolean;
  promoted?: string[];
  claims?: RedisAdmissionEntry[];
  cleaned?: number;
  empty?: boolean;
}
export interface AdmissionControl {
  generation: string;
  epoch: string;
  mode: string;
  runId: string;
  dirty?: string;
}
export function admissionKeys(eventId: string, epoch: string, userId = '_', action = '_') {
  const prefix = `peakpass:admission:${eventId}:`;
  const e = `${prefix}${epoch}:`;
  return [
    prefix + 'control',
    e + 'meta',
    e + 'entries',
    e + 'joins',
    e + 'latest',
    e + 'users',
    e + 'waiting',
    e + 'leases',
    e + 'active',
    e + 'claims',
    e + 'window',
    e + 'sequence',
    `${prefix}limit:${userId}:${action}`,
  ];
}

// All keys are explicit. Each invocation is bounded; Redis owns the clock and budgets.
const script = `
local op, epoch, arg, p = ARGV[1], ARGV[2], cjson.decode(ARGV[3]), cjson.decode(ARGV[4])
local tm=redis.call('TIME'); local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local nilv=cjson.null
local function result(v) v.now=now; v.epoch=epoch; return cjson.encode(v) end
local function err(code,status,wait) return result({ok=false,code=code,status=status,wait=wait}) end
local function kind(k) return redis.call('TYPE',k).ok end
local function newer(a,b) return #a>#b or (#a==#b and a>b) end
local function structures()
  for i=2,6 do
    if kind(KEYS[i])~='hash' or redis.call('HGET',KEYS[i],'__')~=epoch then return false end
  end
  for i=7,11 do
    if kind(KEYS[i])~='zset' or redis.call('ZSCORE',KEYS[i],'__')~='inf' then return false end
  end
  if kind(KEYS[12])~='string' then return false end
  local seq=tonumber(redis.call('GET',KEYS[12]))
  if not seq or seq<0 or seq>9007199254740990 or seq~=math.floor(seq) then return false end
  if redis.call('HLEN',KEYS[3])~=seq+1 or redis.call('HLEN',KEYS[4])~=seq+1 then return false end
  local users=tonumber(redis.call('HGET',KEYS[2],'users'))
  local endAt=tonumber(redis.call('HGET',KEYS[2],'endAt'))
  if not users or users<0 or not endAt or redis.call('HLEN',KEYS[5])~=users+1 then return false end
  if redis.call('ZCARD',KEYS[7])~=redis.call('ZCARD',KEYS[8]) then return false end
  if redis.call('HLEN',KEYS[6])-1~=(redis.call('ZCARD',KEYS[7])-1)+(redis.call('ZCARD',KEYS[9])-1) then return false end
  return true
end
if op=='probe' then
  local empty=true
  for i=2,12 do if redis.call('EXISTS',KEYS[i])==1 then empty=false end end
  local valid=false
  if kind(KEYS[1])=='hash' then
    local mode=redis.call('HGET',KEYS[1],'mode')
    valid=redis.call('HGET',KEYS[1],'generation')==arg.generation and redis.call('HGET',KEYS[1],'epoch')==epoch
      and redis.call('HGET',KEYS[1],'runId')==arg.runId and not redis.call('HGET',KEYS[1],'dirty')
      and (mode=='initializing' or mode=='ready') and structures()
    if valid then valid=now<tonumber(redis.call('HGET',KEYS[2],'endAt')) end
  end
  return result({ok=valid,empty=empty})
end
if op=='initialize' then
  local ct=kind(KEYS[1])
  if ct=='hash' then
    local gen=redis.call('HGET',KEYS[1],'generation')
    if gen and newer(gen,arg.generation) then return err('ADMISSION_RECOVERING',503,1000) end
    if gen==arg.generation then
      if redis.call('HGET',KEYS[1],'epoch')~=epoch or redis.call('HGET',KEYS[1],'runId')~=arg.runId
        or redis.call('HGET',KEYS[1],'mode')=='frozen' or redis.call('HGET',KEYS[1],'dirty') or not structures() then
        return err('ADMISSION_RECOVERING',503,1000)
      end
      return result({ok=true})
    end
  end
  -- Never erase a partly initialized namespace; recovery must allocate another generation.
  for i=2,12 do if redis.call('EXISTS',KEYS[i])==1 then return err('ADMISSION_RECOVERING',503,1000) end end
  if ct~='none' and ct~='hash' then redis.call('DEL',KEYS[1]) end
  redis.call('HSET',KEYS[1],'generation',arg.generation,'epoch',epoch,'mode','initializing','runId',arg.runId,'dirty','1')
  for i=2,6 do redis.call('HSET',KEYS[i],'__',epoch) end
  redis.call('HSET',KEYS[2],'endAt',now+p.epochMs,'users',0)
  for i=7,11 do redis.call('ZADD',KEYS[i],'+inf','__') end
  redis.call('SET',KEYS[12],'0')
  redis.call('HDEL',KEYS[1],'dirty')
  return result({ok=true})
end
if kind(KEYS[1])~='hash' then return err('ADMISSION_RECOVERING',503,1000) end
if redis.call('HGET',KEYS[1],'epoch')~=epoch then return err('ADMISSION_RESET',410) end
if op=='freeze' then
  if redis.call('HGET',KEYS[1],'generation')~=arg.generation then return err('ADMISSION_RECOVERING',503,1000) end
  redis.call('HSET',KEYS[1],'mode','frozen'); return result({ok=true})
end
if redis.call('HGET',KEYS[1],'dirty') or not structures() then return err('ADMISSION_RECOVERING',503,1000) end
local mode=redis.call('HGET',KEYS[1],'mode')
if op=='publish' then
  if redis.call('HGET',KEYS[1],'generation')~=arg.generation or (mode~='initializing' and mode~='ready') then
    return err('ADMISSION_RECOVERING',503,1000)
  end
  redis.call('HSET',KEYS[1],'mode','ready'); return result({ok=true})
end
if mode~='ready' then return err('ADMISSION_RECOVERING',503,1000) end
local endAt=tonumber(redis.call('HGET',KEYS[2],'endAt'))
-- The session deadline closes registration, claims and promotion. Token-matched durable
-- finalization of already approved claims stays open until this generation is frozen.
local finalizing=op=='complete' or op=='close' or op=='reconcile'
if not endAt or (now>=endAt and not finalizing) then return err('ADMISSION_RECOVERING',503,1000) end
local function read(id)
  if not id then return nil end
  local raw=redis.call('HGET',KEYS[3],id)
  if not raw then error('Admission reference missing') end
  local e=cjson.decode(raw)
  if e.admissionId~=id or e.epoch~=epoch or not e.userId or not e.sequence then error('Admission entry corrupt') end
  return e
end
local function save(e) redis.call('HSET',KEYS[3],e.admissionId,cjson.encode(e)) end
local function clearActive(e)
  redis.call('ZREM',KEYS[7],e.admissionId); redis.call('ZREM',KEYS[8],e.admissionId)
  redis.call('ZREM',KEYS[9],e.admissionId); redis.call('ZREM',KEYS[10],e.admissionId)
  if redis.call('HGET',KEYS[6],e.userId)==e.admissionId then redis.call('HDEL',KEYS[6],e.userId) end
end
local function terminal(e,state,reason)
  clearActive(e); e.state=state; e.phase='idle'; e.expiresAt=nilv; e.reason=reason; save(e)
end
local function expire(e)
  if e and (e.state=='waiting' or (e.state=='admitted' and e.phase=='idle')) and e.expiresAt<=now then
    terminal(e,'expired','ADMISSION_EXPIRED')
  end
end
local function snapshot(e)
  if e then
    e.position=nilv
    if e.state=='waiting' then
      local rank=redis.call('ZRANK',KEYS[7],e.admissionId)
      if not rank then error('Waiting index missing') end
      e.position=rank+1
    end
  end
  return e
end
-- Validate all directly referenced records before mutating anything.
local target=nil
if arg.admissionId and op~='join' then target=read(redis.call('HEXISTS',KEYS[3],arg.admissionId)==1 and arg.admissionId or nil) end
local latest=arg.userId and read(redis.call('HGET',KEYS[5],arg.userId)) or nil
local active=arg.userId and read(redis.call('HGET',KEYS[6],arg.userId)) or nil
local joined=arg.joinRequestId and read(redis.call('HGET',KEYS[4],arg.joinRequestId)) or nil
if latest and latest.userId~=arg.userId then return err('ADMISSION_RECOVERING',503,1000) end
if active and active.userId~=arg.userId then return err('ADMISSION_RECOVERING',503,1000) end
if op=='status' or op=='join' or op=='cancel' then
  if kind(KEYS[13])~='none' and kind(KEYS[13])~='zset' then return err('ADMISSION_UNAVAILABLE',503,1000) end
end
-- A shared dirty bit fences partial script failures across app instances. Never clear it on error.
redis.call('HSET',KEYS[1],'dirty','1')
local function done(v) redis.call('HDEL',KEYS[1],'dirty'); return result(v) end
local function deny(code,status,wait,e) return done({ok=false,code=code,status=status,wait=wait,entry=e and snapshot(e)}) end
if op=='status' or op=='join' or op=='cancel' then
  redis.call('ZREMRANGEBYSCORE',KEYS[13],'-inf',now-60000)
  local limit=op=='status' and 120 or 10
  if redis.call('ZCARD',KEYS[13])>=limit then
    local first=redis.call('ZRANGE',KEYS[13],0,0,'WITHSCORES')
    redis.call('PEXPIRE',KEYS[13],60000)
    return deny('ADMISSION_RATE_LIMITED',429,math.max(1,tonumber(first[2])+60000-now))
  end
  redis.call('ZADD',KEYS[13],now,arg.requestId); redis.call('PEXPIRE',KEYS[13],60000)
end
if op=='status' then
  expire(latest)
  if latest and latest.state=='waiting' then latest.expiresAt=now+p.leaseMs; save(latest); redis.call('ZADD',KEYS[8],latest.expiresAt,latest.admissionId) end
  return done({ok=true,entry=snapshot(latest)})
elseif op=='join' then
  if joined then
    if joined.userId~=arg.userId then return deny('ADMISSION_REQUEST_MISMATCH',409) end
    expire(joined)
    if joined.state=='waiting' then joined.expiresAt=now+p.leaseMs; save(joined); redis.call('ZADD',KEYS[8],joined.expiresAt,joined.admissionId) end
    return done({ok=true,entry=snapshot(joined),created=false})
  end
  expire(active)
  if active and (active.state=='waiting' or active.state=='admitted') then return deny('ACTIVE_ADMISSION_EXISTS',409,nil,active) end
  if redis.call('ZCARD',KEYS[7])-1>=p.maxWaiting or tonumber(redis.call('GET',KEYS[12]))>=p.maxEntries then
    return deny('ADMISSION_QUEUE_FULL',429,1000)
  end
  local seq=redis.call('INCR',KEYS[12])
  local e={admissionId=arg.admissionId,userId=arg.userId,epoch=epoch,sequence=string.format('%.0f',seq),state='waiting',phase='idle',
    joinedAt=now,admittedAt=nilv,expiresAt=now+p.leaseMs,reason=nilv,outcome=nilv}
  save(e); redis.call('HSET',KEYS[4],arg.joinRequestId,e.admissionId)
  if not latest then redis.call('HINCRBY',KEYS[2],'users',1) end
  redis.call('HSET',KEYS[5],arg.userId,e.admissionId); redis.call('HSET',KEYS[6],arg.userId,e.admissionId)
  redis.call('ZADD',KEYS[7],seq,e.admissionId); redis.call('ZADD',KEYS[8],e.expiresAt,e.admissionId)
  return done({ok=true,entry=snapshot(e),created=true})
elseif op=='tick' then
  local cleaned=0; local promoted={}
  local expired=redis.call('ZRANGEBYSCORE',KEYS[8],'-inf',now,'LIMIT',0,p.cleanup)
  for _,id in ipairs(expired) do expire(read(id)); cleaned=cleaned+1 end
  -- C is small and claims must not be removed by an expiry-score bulk delete.
  local admitted=redis.call('ZRANGE',KEYS[9],0,p.capacity-1)
  for _,id in ipairs(admitted) do
    if id~='__' and cleaned<p.cleanup then local e=read(id)
      if e.phase=='idle' and e.expiresAt<=now then expire(e); cleaned=cleaned+1 end
    end
  end
  redis.call('ZREMRANGEBYSCORE',KEYS[11],'-inf',now-1000)
  if cleaned<p.cleanup then
    local n=math.min(p.batch,p.rate-(redis.call('ZCARD',KEYS[11])-1),p.capacity-(redis.call('ZCARD',KEYS[9])-1))
    for i=1,n do
      local first=redis.call('ZRANGE',KEYS[7],0,0)[1]
      if first=='__' then break end
      local e=read(first)
      if e.expiresAt<=now then break end
      e.state='admitted'; e.admittedAt=now; e.expiresAt=now+p.ttlMs
      redis.call('ZREM',KEYS[7],first); redis.call('ZREM',KEYS[8],first)
      redis.call('ZADD',KEYS[9],e.expiresAt,first); redis.call('ZADD',KEYS[11],now,first); save(e)
      table.insert(promoted,first)
    end
  end
  return done({ok=true,promoted=promoted,cleaned=cleaned})
elseif op=='reconcile' then
  local claims={}
  for _,id in ipairs(redis.call('ZRANGEBYSCORE',KEYS[10],'-inf',now,'LIMIT',0,p.reclaim)) do
    local e=read(id); e.phase='reconciling'; save(e); table.insert(claims,e)
  end
  return done({ok=true,claims=claims})
elseif op=='inspect' then return done({ok=true,entry=snapshot(target)})
end
if not target or target.userId~=arg.userId then return deny('ADMISSION_NOT_FOUND',404) end
if op=='cancel' then
  expire(target)
  if target.state=='consumed' then return deny('ADMISSION_ALREADY_CONSUMED',409) end
  if target.phase~='idle' then return deny('ADMISSION_IN_PROGRESS',409) end
  if target.state=='waiting' or target.state=='admitted' then terminal(target,'cancelled','ADMISSION_CANCELLED') end
  return done({ok=true,entry=snapshot(target)})
elseif op=='claim' then
  expire(target)
  if target.fingerprint and target.fingerprint~=arg.fingerprint then return deny('ADMISSION_REQUEST_MISMATCH',409) end
  if target.state=='waiting' then return deny('ADMISSION_NOT_READY',409) end
  if target.state=='consumed' then return deny('ADMISSION_ALREADY_CONSUMED',409) end
  if target.state=='expired' or target.state=='cancelled' then return deny(target.reason,410) end
  if target.phase~='idle' then
    if target.deadline<=now then target.phase='reconciling'; save(target); return deny('ADMISSION_IN_PROGRESS',409) end
    return done({ok=true,entry=snapshot(target)})
  end
  target.phase='processing'; target.fingerprint=arg.fingerprint; target.claimToken=arg.claimToken; target.deadline=now+p.claimMs
  redis.call('ZADD',KEYS[10],target.deadline,target.admissionId); save(target)
  return done({ok=true,entry=snapshot(target)})
elseif op=='complete' or op=='close' then
  if target.claimToken~=arg.claimToken or target.fingerprint~=arg.fingerprint then return deny('ADMISSION_REQUEST_MISMATCH',409) end
  if target.state=='consumed' or target.state=='expired' then return done({ok=true,entry=snapshot(target)}) end
  if target.state~='admitted' or target.phase=='idle' then return deny('ADMISSION_IN_PROGRESS',409) end
  if op=='complete' then target.outcome=arg.outcome; terminal(target,'consumed',nilv)
  else terminal(target,'expired','ADMISSION_EXPIRED') end
  return done({ok=true,entry=snapshot(target)})
end
return deny('ADMISSION_INVALID_INPUT',400)
`;

type Operation =
  | 'join'
  | 'status'
  | 'cancel'
  | 'tick'
  | 'claim'
  | 'complete'
  | 'close'
  | 'reconcile'
  | 'inspect'
  | 'initialize'
  | 'publish'
  | 'freeze'
  | 'probe';
export async function runAdmission(
  eventId: string,
  epoch: string,
  operation: Operation,
  input: Record<string, unknown> = {},
): Promise<RedisAdmissionResult> {
  return withRedis(async (redis) => {
    const value = await redis.eval(script, {
      keys: admissionKeys(eventId, epoch, String(input.userId ?? '_'), operation),
      arguments: [
        operation,
        epoch,
        JSON.stringify({ ...input, requestId: randomUUID() }),
        JSON.stringify(admissionProfile),
      ],
    });
    const result = JSON.parse(String(value)) as RedisAdmissionResult;
    if (result.promoted && !Array.isArray(result.promoted)) result.promoted = [];
    if (result.claims && !Array.isArray(result.claims)) result.claims = [];
    return result;
  });
}
export async function getAdmissionControl(eventId: string): Promise<AdmissionControl | null> {
  const control = await withRedis((r) => r.hGetAll(admissionKeys(eventId, '_')[0]));
  return Object.keys(control).length ? (control as unknown as AdmissionControl) : null;
}
export const initializeAdmission = (
  policy: { eventId: string; epoch: string; generation: string },
  runId: string,
) =>
  runAdmission(policy.eventId, policy.epoch, 'initialize', {
    generation: policy.generation,
    runId,
  });
export const publishAdmission = (eventId: string, epoch: string, generation: string) =>
  runAdmission(eventId, epoch, 'publish', { generation });
export const freezeAdmission = (eventId: string, epoch: string, generation: string) =>
  runAdmission(eventId, epoch, 'freeze', { generation });

/**
 * Caller holds the event's exclusive PG gate with protection released, so nothing can publish here.
 * `leftovers` are keys of this event's earlier epochs that a bounded scan found.
 */
export async function retireAdmission(eventId: string, leftovers: string[] = []): Promise<void> {
  const prefix = `peakpass:admission:${eventId}:`;
  await withRedis(async (r) => {
    // A control of another type is stale as well; only its epoch keys are then unknown.
    const epoch =
      (await r.type(prefix + 'control')) === 'hash'
        ? await r.hGet(prefix + 'control', 'epoch')
        : null;
    const own = epoch ? admissionKeys(eventId, epoch).slice(0, 12) : [prefix + 'control'];
    await r.unlink([...new Set([...own, ...leftovers.filter((key) => key.startsWith(prefix))])]);
  });
}

export async function unlinkRetiredAdmission(
  eventId: string,
  observed: AdmissionControl,
  keys: string[],
): Promise<number> {
  const prefix = `peakpass:admission:${eventId}:`;
  const retired = keys
    .filter((key) => {
      if (!key.startsWith(prefix)) return false;
      const epoch = key.slice(prefix.length).split(':')[0];
      return /^[0-9a-f-]{36}$/.test(epoch) && epoch !== observed.epoch;
    })
    .slice(0, 100);
  if (!retired.length) return 0;
  return Number(
    await withRedis((r) =>
      r.eval(
        `
    if redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('HGET',KEYS[1],'generation')~=ARGV[1]
      or redis.call('HGET',KEYS[1],'epoch')~=ARGV[2] or redis.call('HGET',KEYS[1],'mode')~='ready' then return 0 end
    return redis.call('UNLINK',unpack(KEYS,2))`,
        {
          keys: [prefix + 'control', ...retired],
          arguments: [observed.generation, observed.epoch],
        },
      ),
    ),
  );
}
