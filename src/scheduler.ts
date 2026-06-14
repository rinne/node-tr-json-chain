// Periodic seal & timestamp events for a tr-json-chain.
//
// `EventChainScheduler` is a standalone, independently-importable helper (like
// the CSV classes) that drives an existing `EventChainLogger` to emit canonical
// `ts` and `seal` events on a timer. It changes nothing about the chain format
// or hashing — it only calls the logger's public write API.
//
// A `seal` embeds a compact JWS (JWT) signed with an externally-held private key
// that names a recent chain `event_id`; see CANONICAL-EVENTS.md and specs/scheduler.md.
//
// The only dependency is `node:crypto` (key generation + JWS signing). No `pg`
// here — the live `EventChainLogger` instance owns the database connection.

import {
  sign,
  constants,
  randomUUID,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { EventChainLogger } from './event-chain-logger';

/** Thrown by every instance method after {@link EventChainScheduler.end} has been called. */
export class SchedulerEndedError extends Error {
  constructor(message = 'scheduler has ended') {
    super(message);
    this.name = 'SchedulerEndedError';
  }
}

/**
 * Thrown when a seal cannot be produced for a configuration reason that won't
 * fix itself on retry: the chain-root carries no matching public `sealKey`, the
 * root key disagrees with the signing key, or the root event has no `chain`
 * (so the JWT `sub` cannot be set). The scheduler reports it via the `'error'`
 * event and auto-unschedules that seal (see specs/scheduler.md §6.3).
 */
export class SealPrecheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealPrecheckError';
  }
}

/** A signature algorithm permitted for seals (see CANONICAL-EVENTS.md). */
export type SealAlgorithm =
  | 'ES256' | 'ES384' | 'ES512'
  | 'RS256' | 'RS384' | 'RS512'
  | 'PS256' | 'PS384' | 'PS512';

/** Opaque token returned by `scheduleSeal`/`scheduleTimestamp`; pass to `unschedule`. */
export type ScheduleHandle = object;

/** Options for {@link EventChainScheduler.generateSealKeyPair}. */
export interface GenerateSealKeyPairOptions {
  /** Key id written into both JWKs (and later the JWS header). Defaults to a random UUID. */
  kid?: string;
  /**
   * RSA modulus size in bits (RSA algorithms only; a `TypeError` if given for an
   * EC algorithm). Must be a safe integer. Below the family minimum or above 8192
   * throws `RangeError`. Defaults: 2048 / 3072 / 4096 for the 256 / 384 / 512
   * families.
   */
  modulusLength?: number;
}

/** A freshly generated seal key pair (both members are JWKs). */
export interface SealKeyPair {
  /** Public JWK — publish this in the chain-root `sealKey`. */
  publicKey: JsonWebKey;
  /** Private JWK — keep this secret; pass it to {@link EventChainScheduler.scheduleSeal}. */
  secretKey: JsonWebKey;
}

/** Constructor options for {@link EventChainScheduler}. */
export interface EventChainSchedulerOptions {
  /** Convenience `'error'` listener; equivalent to `scheduler.on('error', onError)`. */
  onError?: (err: unknown, handle?: ScheduleHandle) => void;
  /** Epoch-ms clock; defaults to `Date.now`. For deterministic tests. */
  clock?: () => number;
  /** Timer arming; defaults to `setTimeout` (with `unref()`). For deterministic tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Timer cancelling; defaults to `clearTimeout`. For deterministic tests. */
  clearTimer?: (token: unknown) => void;
}

interface AlgSpec {
  kty: 'EC' | 'RSA';
  hash: 'sha256' | 'sha384' | 'sha512';
  /** EC named curve (OpenSSL name). */
  curve?: 'prime256v1' | 'secp384r1' | 'secp521r1';
  /** RSA padding scheme. */
  padding?: 'pkcs1' | 'pss';
  /** RSA modulus family (default/minimum lookup). */
  family?: 256 | 384 | 512;
}

const ALGS: Record<SealAlgorithm, AlgSpec> = {
  ES256: { kty: 'EC', hash: 'sha256', curve: 'prime256v1' },
  ES384: { kty: 'EC', hash: 'sha384', curve: 'secp384r1' },
  ES512: { kty: 'EC', hash: 'sha512', curve: 'secp521r1' },
  RS256: { kty: 'RSA', hash: 'sha256', padding: 'pkcs1', family: 256 },
  RS384: { kty: 'RSA', hash: 'sha384', padding: 'pkcs1', family: 384 },
  RS512: { kty: 'RSA', hash: 'sha512', padding: 'pkcs1', family: 512 },
  PS256: { kty: 'RSA', hash: 'sha256', padding: 'pss', family: 256 },
  PS384: { kty: 'RSA', hash: 'sha384', padding: 'pss', family: 384 },
  PS512: { kty: 'RSA', hash: 'sha512', padding: 'pss', family: 512 },
};

const RSA_MODULUS: Record<256 | 384 | 512, { def: number; min: number }> = {
  256: { def: 2048, min: 2048 },
  384: { def: 3072, min: 3072 },
  512: { def: 4096, min: 4096 },
};
const RSA_MAX_MODULUS = 8192;

const INITIAL_DELAY_MIN_MS = 1000;
const INITIAL_DELAY_MAX_MS = 2000;
const MIN_GAP_AFTER_COMPLETION_MS = 1000;

function isSealAlgorithm(v: unknown): v is SealAlgorithm {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ALGS, v);
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** Public-key SPKI DER for an arbitrary JWK (robust to equivalent encodings). */
function publicKeyDer(jwk: JsonWebKey): Buffer {
  return createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' });
}

/** Signs a compact JWS (`header.payload.signature`) with the given JWK. */
function signCompactJws(
  alg: SealAlgorithm,
  secretKey: JsonWebKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string {
  const spec = ALGS[alg];
  const key = createPrivateKey({ key: secretKey, format: 'jwk' });
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const data = Buffer.from(signingInput, 'ascii');
  let signature: Buffer;
  if (spec.kty === 'EC') {
    // JWS requires the raw R||S concatenation, not OpenSSL's DER encoding.
    signature = sign(spec.hash, data, { key, dsaEncoding: 'ieee-p1363' });
  } else if (spec.padding === 'pss') {
    signature = sign(spec.hash, data, {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    });
  } else {
    signature = sign(spec.hash, data, key);
  }
  return `${signingInput}.${signature.toString('base64url')}`;
}

interface Schedule {
  readonly handle: ScheduleHandle;
  readonly type: 'seal' | 'timestamp';
  readonly intervalMs: number;
  timer: unknown;
  cancelled: boolean;
  // seal-only:
  secretKey?: JsonWebKey;
  alg?: SealAlgorithm;
  kid?: string;
  prechecked?: boolean;
}

/**
 * Drives an {@link EventChainLogger} to record canonical `ts` and `seal` events
 * on independent timers. Extends EventEmitter; emits `'seal'`, `'timestamp'`,
 * and `'error'`. See specs/scheduler.md for the full contract.
 */
export class EventChainScheduler extends EventEmitter {
  #logger: EventChainLogger | null;
  #ended = false;
  readonly #schedules = new Set<Schedule>();
  readonly #clock: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (token: unknown) => void;

  constructor(logger: EventChainLogger, options: EventChainSchedulerOptions = {}) {
    super();
    if (logger === null || typeof logger !== 'object') {
      throw new TypeError('logger must be an EventChainLogger instance');
    }
    this.#logger = logger;
    this.#clock = options.clock ?? (() => Date.now());
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // Never keep the process alive on the scheduler's account alone.
        if (typeof (t as { unref?: () => void }).unref === 'function') {
          (t as { unref: () => void }).unref();
        }
        return t;
      });
    this.#clearTimer = options.clearTimer ?? ((token) => clearTimeout(token as NodeJS.Timeout));
    if (options.onError) this.on('error', options.onError);
  }

  /**
   * Generates a seal key pair for one of the permitted algorithms. Returns both
   * the public JWK (publish in the chain-root `sealKey`) and the private JWK
   * (keep secret; pass to {@link scheduleSeal}). Both carry `alg`, `kid`, and
   * `use: "sig"`. See specs/scheduler.md §7.
   */
  static generateSealKeyPair(
    alg: SealAlgorithm,
    options: GenerateSealKeyPairOptions = {},
  ): SealKeyPair {
    if (!isSealAlgorithm(alg)) {
      throw new TypeError(`unsupported seal algorithm: ${String(alg)}`);
    }
    if (options.kid !== undefined && typeof options.kid !== 'string') {
      throw new TypeError(`kid must be a string (got ${typeof options.kid})`);
    }
    const spec = ALGS[alg];
    const kid = options.kid ?? randomUUID();

    let publicJwk: JsonWebKey;
    let secretJwk: JsonWebKey;
    if (spec.kty === 'EC') {
      if (options.modulusLength !== undefined) {
        throw new TypeError('modulusLength is only valid for RSA (RS*/PS*) algorithms');
      }
      const { publicKey, privateKey } = generateKeyPairSync('ec', {
        namedCurve: spec.curve as string,
      });
      publicJwk = publicKey.export({ format: 'jwk' });
      secretJwk = privateKey.export({ format: 'jwk' });
    } else {
      const fam = RSA_MODULUS[spec.family as 256 | 384 | 512];
      let modulusLength: number;
      if (options.modulusLength === undefined) {
        modulusLength = fam.def;
      } else {
        if (!Number.isSafeInteger(options.modulusLength)) {
          throw new TypeError(
            `modulusLength must be a safe integer (got ${String(options.modulusLength)})`,
          );
        }
        if (options.modulusLength < fam.min) {
          throw new RangeError(
            `modulusLength ${options.modulusLength} is below the ${alg} minimum of ${fam.min}`,
          );
        }
        if (options.modulusLength > RSA_MAX_MODULUS) {
          throw new RangeError(
            `modulusLength ${options.modulusLength} exceeds the hard maximum of ${RSA_MAX_MODULUS}`,
          );
        }
        modulusLength = options.modulusLength;
      }
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength });
      publicJwk = publicKey.export({ format: 'jwk' });
      secretJwk = privateKey.export({ format: 'jwk' });
    }

    publicJwk.alg = alg;
    publicJwk.kid = kid;
    publicJwk.use = 'sig';
    secretJwk.alg = alg;
    secretJwk.kid = kid;
    secretJwk.use = 'sig';
    return { publicKey: publicJwk, secretKey: secretJwk };
  }

  /**
   * Schedules a periodic `seal` event signed with `secretKey` (a private JWK
   * whose `alg` selects the algorithm; its `kid`, if present, goes into the JWS
   * header and is checked against the chain-root key). Returns a handle for
   * {@link unschedule}. No database access happens here — the first tick fires
   * after a short randomized delay.
   */
  scheduleSeal(secretKey: JsonWebKey, intervalSeconds: number): ScheduleHandle {
    this.#assertActive();
    if (secretKey === null || typeof secretKey !== 'object') {
      throw new TypeError('secretKey must be a private JWK');
    }
    const alg = (secretKey as { alg?: unknown }).alg;
    if (!isSealAlgorithm(alg)) {
      throw new TypeError(
        `secretKey.alg must be one of the permitted seal algorithms (got ${String(alg)})`,
      );
    }
    const kidRaw = (secretKey as { kid?: unknown }).kid;
    if (kidRaw !== undefined && typeof kidRaw !== 'string') {
      throw new TypeError(`secretKey.kid must be a string when present (got ${typeof kidRaw})`);
    }
    const intervalMs = this.#checkInterval(intervalSeconds);
    const schedule: Schedule = {
      handle: {},
      type: 'seal',
      intervalMs,
      timer: undefined,
      cancelled: false,
      secretKey,
      alg,
      kid: kidRaw as string | undefined,
      prechecked: false,
    };
    return this.#arm(schedule);
  }

  /**
   * Schedules a periodic `ts` event (via `logger.timestamp()`). Returns a handle
   * for {@link unschedule}. The first tick fires after a short randomized delay.
   */
  scheduleTimestamp(intervalSeconds: number): ScheduleHandle {
    this.#assertActive();
    const intervalMs = this.#checkInterval(intervalSeconds);
    const schedule: Schedule = {
      handle: {},
      type: 'timestamp',
      intervalMs,
      timer: undefined,
      cancelled: false,
    };
    return this.#arm(schedule);
  }

  /**
   * Cancels a single schedule (by the handle returned from `scheduleSeal`/
   * `scheduleTimestamp`), or — with no argument — every schedule. Cancelling an
   * unknown/already-cancelled handle is a no-op.
   */
  unschedule(handle?: ScheduleHandle): void {
    this.#assertActive();
    if (handle === undefined) {
      for (const s of [...this.#schedules]) this.#remove(s);
      return;
    }
    for (const s of this.#schedules) {
      if (s.handle === handle) {
        this.#remove(s);
        return;
      }
    }
  }

  /**
   * Cancels all schedules, detaches the logger, and renders the instance inert:
   * every subsequent instance method (including a second `end()`) throws
   * {@link SchedulerEndedError}. Not idempotent by design.
   */
  end(): void {
    this.#assertActive();
    for (const s of [...this.#schedules]) this.#remove(s);
    this.#logger = null;
    this.#ended = true;
  }

  #assertActive(): void {
    if (this.#ended) throw new SchedulerEndedError();
  }

  #checkInterval(intervalSeconds: number): number {
    if (
      typeof intervalSeconds !== 'number' ||
      !Number.isFinite(intervalSeconds) ||
      intervalSeconds <= 0
    ) {
      throw new TypeError(
        `intervalSeconds must be a positive finite number (got ${String(intervalSeconds)})`,
      );
    }
    return intervalSeconds * 1000;
  }

  #arm(schedule: Schedule): ScheduleHandle {
    this.#schedules.add(schedule);
    const delay =
      INITIAL_DELAY_MIN_MS +
      Math.random() * (INITIAL_DELAY_MAX_MS - INITIAL_DELAY_MIN_MS);
    schedule.timer = this.#setTimer(() => {
      void this.#tick(schedule);
    }, delay);
    return schedule.handle;
  }

  #remove(schedule: Schedule): void {
    schedule.cancelled = true;
    if (schedule.timer !== undefined) {
      this.#clearTimer(schedule.timer);
      schedule.timer = undefined;
    }
    this.#schedules.delete(schedule);
  }

  async #tick(schedule: Schedule): Promise<void> {
    if (this.#ended || schedule.cancelled) return;
    const startMs = this.#clock();
    let fatal = false;
    try {
      await this.#run(schedule);
    } catch (err) {
      if (err instanceof SealPrecheckError) fatal = true;
      this.emit('error', err, schedule.handle);
    }
    if (this.#ended || schedule.cancelled) return;
    if (fatal) {
      this.#remove(schedule);
      return;
    }
    // Next fire: fixed-rate from this op's start, but never sooner than 1s after
    // it completed. The next timer is armed only now, so ticks never overlap.
    const completeMs = this.#clock();
    const nextAtMs = Math.max(
      startMs + schedule.intervalMs,
      completeMs + MIN_GAP_AFTER_COMPLETION_MS,
    );
    schedule.timer = this.#setTimer(() => {
      void this.#tick(schedule);
    }, nextAtMs - completeMs);
  }

  async #run(schedule: Schedule): Promise<void> {
    const logger = this.#logger;
    if (logger === null) return; // ended between scheduling and firing
    if (schedule.type === 'timestamp') {
      const eventId = await logger.timestamp();
      this.emit('timestamp', { handle: schedule.handle, eventId });
      return;
    }
    await this.#runSeal(logger, schedule);
  }

  async #runSeal(logger: EventChainLogger, schedule: Schedule): Promise<void> {
    // Stable sealed position: getChainHead() inits the chain and appends an
    // empty checkpoint unless the head already is one.
    const sealedHead = await logger.getChainHead();
    const root = await logger.getRootEvent();
    const data = root.data;

    if (!schedule.prechecked) {
      this.#precheckSeal(schedule, data);
      schedule.prechecked = true;
    }

    const chainId = (data as { chain?: unknown } | undefined)?.chain;
    if (typeof chainId !== 'string') {
      throw new SealPrecheckError(
        'chain-root has no string "chain" property; cannot set the seal JWT "sub"',
      );
    }

    const now = new Date(this.#clock());
    const header: Record<string, unknown> = { alg: schedule.alg };
    if (schedule.kid !== undefined) header.kid = schedule.kid;
    header['chain-op'] = 'seal';
    const claims: Record<string, unknown> = {
      iat: Math.floor(now.getTime() / 1000),
      sub: chainId,
      'sealed-head': sealedHead,
    };
    const jws = signCompactJws(schedule.alg as SealAlgorithm, schedule.secretKey as JsonWebKey, header, claims);

    const eventId = await logger.recordEvent({
      type: 'seal',
      ts: now.toISOString(),
      'sealed-head': sealedHead,
      seal: jws,
    });
    this.emit('seal', { handle: schedule.handle, eventId, sealedHead });
  }

  /**
   * Verifies the chain-root's public `sealKey` against the signing key: the
   * public key itself must match; `kid` and `alg` are checked only if present in
   * the root key. Throws {@link SealPrecheckError} (→ auto-unschedule) on mismatch.
   */
  #precheckSeal(schedule: Schedule, rootData: unknown): void {
    const sealKey = (rootData as { sealKey?: unknown } | undefined)?.sealKey;
    if (sealKey === null || typeof sealKey !== 'object') {
      throw new SealPrecheckError('chain-root has no sealKey; cannot verify produced seals');
    }
    let rootDer: Buffer;
    try {
      rootDer = publicKeyDer(sealKey as JsonWebKey);
    } catch (err) {
      throw new SealPrecheckError(
        `chain-root sealKey is not a usable public key: ${(err as Error).message}`,
      );
    }
    const signingDer = publicKeyDer(schedule.secretKey as JsonWebKey);
    if (!rootDer.equals(signingDer)) {
      throw new SealPrecheckError(
        'chain-root sealKey public key does not match the signing key',
      );
    }
    const rootKid = (sealKey as { kid?: unknown }).kid;
    if (rootKid !== undefined && rootKid !== schedule.kid) {
      throw new SealPrecheckError(
        `chain-root sealKey kid (${String(rootKid)}) does not match the signing key kid (${String(schedule.kid)})`,
      );
    }
    const rootAlg = (sealKey as { alg?: unknown }).alg;
    if (rootAlg !== undefined && rootAlg !== schedule.alg) {
      throw new SealPrecheckError(
        `chain-root sealKey alg (${String(rootAlg)}) does not match the signing alg (${String(schedule.alg)})`,
      );
    }
  }
}
