import { describe, it, expect, vi } from 'vitest';
import { apply as applyTurnRecovery } from '../../runtime/dsh/upstream/turn-recovery.js';

/** A fake cordis context recording the plugin's listeners and answering
 * ctx.get('agents') with `registry`. Mirrors the three faces the supervisor
 * uses: ctx.get, ctx.on, ctx.effect (never fired here). */
const fakeCtx = (registry) => {
    const listeners = new Map();
    return {
        listeners,
        on(event, handler) {
            listeners.set(event, handler);
        },
        effect() {},
        get() {
            return registry;
        },
        /** Deliver one event to the plugin's recorded handler. */
        emit(event, payload) {
            listeners.get(event)?.(payload);
        },
    };
};

/** A fake agent standing for the vendored ReactLoopAgent face the supervisor
 * touches: id, journal appends (the append's surface-metadata `opts` recorded
 * too — the vendored log contract makes `surfaceOp` REQUIRED on the four
 * message-producing types), the inbox projection, and the (private-typed)
 * wakeDriver entry as a recorded spy. */
const fakeAgent = ({ id, pending = false, wakeable = true }) => ({
    id,
    inbox: { hasPending: pending },
    session: {
        appended: [],
        append(type, data, opts) {
            this.appended.push({ type, data, opts });
            return { seq: this.appended.length };
        },
    },
    ...(wakeable ? {} : {}),
    ...(wakeable
        ? { wakeDriver: vi.fn() }
        : {}),
});

const mountSupervisor = (agents = []) => {
    const registry = { list: () => agents };
    const ctx = fakeCtx(registry);
    applyTurnRecovery(ctx);
    return ctx;
};

describe('turn recovery: an errored turn closes honestly and followups continue', () => {
    it('a failed turn with queued followups appends one system note and re-arms the driver', () => {
        const agent = fakeAgent({ id: 'session-a', pending: true });
        const ctx = mountSupervisor([agent]);

        ctx.emit('agent/error', { agent, error: new Error('LLM stream cut mid-frame') });
        ctx.emit('agent/status', { agent, status: 'idle' });

        const notes = agent.session.appended.filter((a) => a.type === 'system/message');
        expect(notes).toHaveLength(1);
        // The note joins the chat surface: the journal event carries the legal
        // append marker — without it the vendored log rejects the append
        // (surface-eligible event without a surfaceOp) and the journal record
        // is lost while only the transient bus banner survives.
        expect(notes[0].opts).toEqual({ surfaceOp: 'append' });
        expect(notes[0].data.message.content[0].text).toContain('Turn failed:');
        expect(notes[0].data.message.content[0].text).toContain('LLM stream cut mid-frame');
        expect(notes[0].data.message.content[0].text).toContain('queued messages continue');
        expect(agent.wakeDriver).toHaveBeenCalledTimes(1);
    });

    it('a failed turn WITHOUT queued work notes the failure but never wakes the driver', () => {
        const agent = fakeAgent({ id: 'session-b', pending: false });
        const ctx = mountSupervisor([agent]);

        ctx.emit('agent/error', { agent, error: new Error('no retry left') });
        ctx.emit('agent/status', { agent, status: 'idle' });

        const notes = agent.session.appended.filter((a) => a.type === 'system/message');
        expect(notes).toHaveLength(1);
        expect(notes[0].opts).toEqual({ surfaceOp: 'append' });
        expect(notes[0].data.message.content[0].text).toContain('no retry left');
        expect(agent.wakeDriver).not.toHaveBeenCalled();
    });

    it('healthy idle transitions (no error mark) append nothing and never wake', () => {
        const agent = fakeAgent({ id: 'session-c', pending: true });
        const ctx = mountSupervisor([agent]);

        ctx.emit('agent/status', { agent, status: 'running' });
        ctx.emit('agent/status', { agent, status: 'idle' });

        expect(agent.session.appended).toHaveLength(0);
        expect(agent.wakeDriver).not.toHaveBeenCalled();
    });
});

describe('turn recovery: the failure mark is one note per turn', () => {
    it('one error yields exactly one note even across several status events', () => {
        const agent = fakeAgent({ id: 'session-d', pending: true });
        const ctx = mountSupervisor([agent]);

        ctx.emit('agent/error', { agent, error: new Error('boom') });
        ctx.emit('agent/status', { agent, status: 'idle' });
        ctx.emit('agent/status', { agent, status: 'running' });
        ctx.emit('agent/status', { agent, status: 'idle' });

        expect(agent.session.appended.filter((a) => a.type === 'system/message')).toHaveLength(1);
        expect(agent.wakeDriver).toHaveBeenCalledTimes(1);
    });

    it('a second failed turn after recovery notes again (the mark is per-turn)', () => {
        const agent = fakeAgent({ id: 'session-e', pending: true });
        const ctx = mountSupervisor([agent]);

        ctx.emit('agent/error', { agent, error: new Error('first') });
        ctx.emit('agent/status', { agent, status: 'idle' });
        ctx.emit('agent/error', { agent, error: new Error('second') });
        ctx.emit('agent/status', { agent, status: 'idle' });

        const notes = agent.session.appended.filter((a) => a.type === 'system/message');
        expect(notes).toHaveLength(2);
        expect(notes[1].data.message.content[0].text).toContain('second');
        // Every note carries the marker — one per turn, never a degraded one.
        expect(notes.map((n) => n.opts)).toEqual([
            { surfaceOp: 'append' },
            { surfaceOp: 'append' },
        ]);
    });
});

describe('turn recovery: loud on degradation', () => {
    it('a vendored face without wakeDriver degrades loud, appends the note, never throws', () => {
        const agent = fakeAgent({ id: 'session-f', pending: true, wakeable: false });
        const ctx = mountSupervisor([agent]);

        ctx.emit('agent/error', { agent, error: new Error('stream died') });
        expect(() => ctx.emit('agent/status', { agent, status: 'idle' })).not.toThrow();
        expect(agent.session.appended.filter((a) => a.type === 'system/message')).toHaveLength(1);
    });

    it('a rejected append never masks the recovery: the driver still re-arms', () => {
        const agent = fakeAgent({ id: 'session-g', pending: true });
        agent.session.append = () => {
            throw new Error('surface-eligible and requires a surfaceOp marker');
        };
        const ctx = mountSupervisor([agent]);

        ctx.emit('agent/error', { agent, error: new Error('budget exhausted offline') });
        expect(() => ctx.emit('agent/status', { agent, status: 'idle' })).not.toThrow();
        expect(agent.wakeDriver).toHaveBeenCalledTimes(1);
    });

    it('mount fails loud without the agents registry (rule 5)', () => {
        expect(() => applyTurnRecovery(fakeCtx(undefined))).toThrow('agents registry');
    });
});
