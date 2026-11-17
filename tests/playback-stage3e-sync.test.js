import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlaybackControls, getTimelineAudioSeekState } from '../src/lib/playbackControls.js';
import { syncTimelineAudioElement, syncVoiceAudioSegments } from '../src/hooks/useMediaSync.js';

// Model the native hazard: play on ended auto-rewinds; a seek clears ended.
function media(time = 0) {
    let position = time;
    return {
        paused: true, ended: false, playbackRate: 1, volume: 1,
        writes: [], plays: 0, pauses: 0,
        get currentTime() { return position; },
        set currentTime(value) { this.writes.push(value); position = value; this.ended = false; },
        play() { this.plays++; if (this.ended) position = 0; this.ended = false; this.paused = false; },
        pause() { this.pauses++; this.paused = true; },
        end() { position = 7.333469; this.paused = true; this.ended = true; },
    };
}
function fixture(overrides = {}) {
    const voice = media(1), source = media(1), music = media(1);
    const ref = (current) => ({ current });
    const d = {
        isPlaying: false, canPreview: true, estimatedDuration: 7.333458333333334,
        currentTimeRef: ref(0), timelineDurationRef: ref(10),
        playbackSessionRef: ref({ playing: false }),
        visualPlaybackStartTimeRef: ref(0), visualPlaybackStartedAtRef: ref(0),
        visualPlaybackLastUpdateRef: ref(0),
        audioSegments: [{ id: 'voice', start: 0, duration: 7.333458333333334, volume: 1 }],
        audioSegmentRefs: ref(new Map([['voice', voice]])),
        sourceAudioRef: ref(source), sourceAudioUrl: 'source.wav', sourceAudioStart: 0,
        sourceAudioDuration: 7.333458333333334, sourceAudioLinked: false,
        linkedSourceAudioSegments: [], sourceAudioVolume: 1,
        musicRef: ref(music), musicUrl: 'music.wav', musicStart: 0,
        musicDuration: 7.333458333333334, musicVolume: 1,
        musicSegments: [{ id: 'music', start: 0, duration: 7.333458333333334 }],
        previewVideoRef: ref(null), visualSegments: [], visualTimeline: [],
        trackVisibility: {}, notify() { },
        setCurrentTime(value) { d.time = value; },
        setIsPlaying(value) { d.playing = value; },
        ...overrides,
    };
    return { d, voice, source, music, controls: () => createPlaybackControls(d) };
}

test('discrete paused seek aligns voice/source/music without play and remains paused', () => {
    const f = fixture();
    f.controls().seekTo(4.4);
    for (const m of [f.voice, f.source, f.music]) {
        assert.equal(m.currentTime, 4.4); assert.equal(m.paused, true); assert.equal(m.plays, 0);
    }
    assert.equal(f.d.currentTimeRef.current, 4.4);
    assert.equal(f.d.playbackSessionRef.current.playing, false);
});

test('pointer moves defer alignment; explicit completion aligns; Home resets paused audio', () => {
    const f = fixture();
    f.controls().seekTo(4.4, { pause: true, immediate: false });
    assert.equal(f.music.currentTime, 1);
    f.controls().seekTo(4.4, { pause: true, immediate: true });
    assert.equal(f.music.currentTime, 4.4);
    f.controls().seekTo(0);
    assert.equal(f.music.currentTime, 0); assert.equal(f.music.plays, 0);
});

test('paused seek and resume preserve trims/rates and active-track alignment', () => {
    const f = fixture({
        sourceAudioLinked: true,
        linkedSourceAudioSegments: [{ id: 'linked', start: 2, duration: 3, sourceStart: 10, playbackRate: 2 }],
        musicSegments: [{ id: 'music', start: 2, duration: 3, sourceStart: 5, playbackRate: 2 }],
    });
    f.controls().seekTo(3);
    assert.equal(f.source.currentTime, 12); assert.equal(f.music.currentTime, 7);
    f.controls().handlePlayToggle();
    assert.equal(f.source.currentTime, 12); assert.equal(f.music.currentTime, 7);
    assert.equal(f.source.paused, false); assert.equal(f.music.paused, false);
    assert.equal(f.music.playbackRate, 2); assert.equal(f.d.playing, true);
});

test('gap/end seek maps to previous source endpoint and pre-roll maps to first source start', () => {
    const segments = [{ start: 2, duration: 2, sourceStart: 8, playbackRate: 2 }, { start: 6, duration: 1, sourceStart: 20 }];
    assert.equal(getTimelineAudioSeekState(segments, 0).sourceTime, 8);
    assert.equal(getTimelineAudioSeekState(segments, 5).sourceTime, 12);
    assert.equal(getTimelineAudioSeekState(segments, 7).sourceTime, 21);
    assert.equal(getTimelineAudioSeekState([], 7).active, false);
});

test('hidden tracks stay paused and are not positioned by paused seeking', () => {
    const f = fixture({ trackVisibility: { audio: false, source: false, music: false } });
    f.controls().seekTo(4.4);
    for (const m of [f.voice, f.source, f.music]) { assert.equal(m.currentTime, 1); assert.equal(m.plays, 0); }
});

test('resume realigns paused seek and explicit replay from terminal starts at zero', () => {
    const f = fixture();
    f.controls().seekTo(4.4); f.controls().handlePlayToggle();
    assert.equal(f.music.currentTime, 4.4); assert.equal(f.music.plays, 1);
    f.d.isPlaying = true;
    f.controls().finishTimelinePlayback(f.d.estimatedDuration);
    assert.equal(f.music.paused, true);
    assert.equal(f.music.currentTime, f.d.estimatedDuration);
    f.d.isPlaying = false;
    f.music.end();
    f.controls().handlePlayToggle();
    assert.equal(f.music.currentTime, 0); assert.equal(f.music.paused, false);
    assert.equal(f.d.currentTimeRef.current, 0); assert.equal(f.d.playbackSessionRef.current.playing, true);
});

for (const expectedTime of [7.30, 7.26]) {
    test(`native ended blocks queued sync before seek or play (${expectedTime})`, () => {
        const m = media(); const session = { playing: true }; const sessionRef = { current: session };
        m.end();
        syncTimelineAudioElement(m, { active: true, shouldPlay: true, expectedTime, session, sessionRef, segmentKey: 'music' });
        assert.equal(m.currentTime, 7.333469); assert.equal(m.ended, true);
        assert.deepEqual(m.writes, []); assert.equal(m.plays, 0);
    });
}

test('terminal live clock blocks sync even before native ended', () => {
    const m = media(7.31); const session = { playing: true }; const sessionRef = { current: session };
    syncTimelineAudioElement(m, { active: true, shouldPlay: true, expectedTime: 7.28, session, sessionRef, terminal: true });
    assert.equal(m.currentTime, 7.31); assert.equal(m.plays, 0); assert.deepEqual(m.writes, []);
});

test('stop invalidates old playing effect before native pause and stale stopped effect cannot pause replay', () => {
    const f = fixture({ isPlaying: true });
    const old = f.d.playbackSessionRef.current = { playing: true };
    f.controls().finishTimelinePlayback(f.d.estimatedDuration);
    syncTimelineAudioElement(f.music, { active: true, shouldPlay: true, expectedTime: 7.26, session: old, sessionRef: f.d.playbackSessionRef });
    assert.equal(f.music.plays, 0); assert.equal(f.music.currentTime, f.d.estimatedDuration);
    const stopped = f.d.playbackSessionRef.current;
    f.d.isPlaying = false; f.controls().handlePlayToggle();
    syncTimelineAudioElement(f.music, { active: false, shouldPlay: false, expectedTime: 0, session: stopped, sessionRef: f.d.playbackSessionRef });
    assert.equal(f.music.paused, false);
});

test('running seek preserves session and moves anchors without near-end replay reset', () => {
    const f = fixture({ isPlaying: true }); const session = f.d.playbackSessionRef.current = { playing: true };
    f.controls().seekTo(7.32);
    assert.equal(f.d.playbackSessionRef.current, session);
    assert.equal(f.d.currentTimeRef.current, 7.32); assert.equal(f.d.visualPlaybackStartTimeRef.current, 7.32);
});

test('legitimate shared-element segment transition can seek ended source and continue', () => {
    const m = media(); const session = { playing: true }; const sessionRef = { current: session };
    syncTimelineAudioElement(m, { active: true, shouldPlay: true, expectedTime: 0, session, sessionRef, segmentKey: 'first' });
    m.end();
    syncTimelineAudioElement(m, { active: true, shouldPlay: true, expectedTime: 2, session, sessionRef, segmentKey: 'second' });
    assert.equal(m.currentTime, 2); assert.equal(m.paused, false); assert.equal(m.plays, 2);
});

test('voice synchronization ignores obsolete session after pause', () => {
    const f = fixture(); const old = f.d.playbackSessionRef.current = { playing: true };
    f.controls().seekTo(4.4, { pause: true });
    syncVoiceAudioSegments({
        segments: f.d.audioSegments, refs: f.d.audioSegmentRefs, timelineTime: 1,
        isPlaying: true, visibility: {}, session: old, sessionRef: f.d.playbackSessionRef
    });
    assert.equal(f.voice.currentTime, 4.4); assert.equal(f.voice.plays, 0);
});

test('existing 40ms start and 150ms running correction thresholds remain unchanged', () => {
    const m = media(4.8); m.paused = false;
    syncTimelineAudioElement(m, { active: true, shouldPlay: true, expectedTime: 4.85 });
    assert.equal(m.currentTime, 4.8);
    syncTimelineAudioElement(m, { active: true, shouldPlay: true, expectedTime: 0 });
    assert.equal(m.currentTime, 0);
    m.paused = true;
    syncTimelineAudioElement(m, { active: true, shouldPlay: true, expectedTime: 0.03 });
    assert.equal(m.currentTime, 0); assert.equal(m.plays, 1);
});
