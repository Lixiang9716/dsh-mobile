/**
 * styles.ts — the Lynx face of the token single source, composed into the
 * surface's style objects. Every color/radius/gradient here is
 * `theme.generated.ts` (generated from theme/tokens.json) — nothing is
 * hand-tinted; the aurora-blooded dark look is data, exactly like the web
 * face's CSS custom properties.
 */
import { theme, radius, gradient } from './theme.generated.js';

export { theme, radius, gradient };

const absolutes = {
  position: 'absolute' as const,
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
};

export const styles = {
  root: {
    flex: 1,
    backgroundColor: theme.bg,
    flexDirection: 'column' as const,
  },
  column: { flex: 1, flexDirection: 'column' as const },

  // aurora backdrop: layered translucent blobs over the deep-ocean base —
  // the web client's ocean-backdrop radial gradients, expressed as native
  // views (Lynx-safe: no radial-gradient dependency)
  backdrop: absolutes,
  blobOcean: {
    position: 'absolute' as const,
    top: -140,
    left: -100,
    width: 380,
    height: 380,
    borderRadius: 190,
    backgroundColor: theme.blobOcean,
  },
  blobHaze: {
    position: 'absolute' as const,
    top: 40,
    right: -120,
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: theme.blobHaze,
  },
  blobPurple: {
    position: 'absolute' as const,
    bottom: -80,
    left: -60,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: theme.blobPurple,
  },

  // top bar
  topBar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    height: 52,
    paddingLeft: 14,
    paddingRight: 14,
    backgroundColor: theme.glassBg,
    borderBottomWidth: 0.7,
    borderBottomColor: theme.glassStroke,
  },
  topBarSide: { width: 56, flexDirection: 'row' as const, alignItems: 'center' as const },
  wordmark: {
    flex: 1,
    textAlign: 'center' as const,
    color: theme.text,
    fontSize: 17,
    fontWeight: '700' as const,
    letterSpacing: 2,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: theme.fill,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  iconBtnText: { color: theme.text2, fontSize: 16 },
  connDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },

  // thread
  thread: { flex: 1, paddingLeft: 14, paddingRight: 14, paddingTop: 10 },
  row: { marginBottom: 10 },
  bubbleUser: {
    backgroundColor: theme.userBubble,
    borderWidth: 0.7,
    borderColor: theme.userBubbleLine,
    borderRadius: radius.bubble,
    padding: 11,
    marginLeft: 56,
  },
  bubbleUserText: { color: theme.text, fontSize: 15, lineHeight: 22 },
  assistantBlock: { marginRight: 24 },
  assistantHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    marginBottom: 5,
  },
  assistantAvatar: { color: theme.oceanBright, fontSize: 12, marginRight: 6 },
  assistantName: { color: theme.text2, fontSize: 12, fontWeight: '600' as const },
  assistantBadge: {
    color: theme.orange,
    fontSize: 11,
    marginLeft: 8,
    backgroundColor: theme.fill,
    borderRadius: 6,
    paddingLeft: 6,
    paddingRight: 6,
    paddingTop: 1,
    paddingBottom: 1,
  },
  mdText: { color: theme.text, fontSize: 15, lineHeight: 23 },
  mdBold: { fontWeight: '700' as const },
  mdItalic: { fontStyle: 'italic' as const },
  mdCode: {
    color: theme.mist,
    backgroundColor: theme.fill,
    borderRadius: 4,
    fontSize: 14,
  },
  mdLink: { color: theme.oceanBright },
  mdHeading: { color: theme.text, fontSize: 17, fontWeight: '700' as const, marginTop: 6 },
  mdListItem: { color: theme.text, fontSize: 15, lineHeight: 23 },
  codeBlock: {
    backgroundColor: theme.navy,
    borderRadius: radius.output,
    padding: 10,
    marginTop: 4,
    marginBottom: 6,
  },
  codeBlockText: { color: theme.mist, fontSize: 13, lineHeight: 19 },

  // streaming tail
  tailWrap: { marginRight: 24 },
  tailState: { color: theme.text3, fontSize: 12, marginBottom: 4 },
  tailReason: { color: theme.text3, fontSize: 13, lineHeight: 20, marginBottom: 4 },
  tailText: { color: theme.text, fontSize: 15, lineHeight: 23 },
  cursor: {
    color: theme.oceanBright,
    fontSize: 15,
  },

  // tool cards (three states)
  card: {
    backgroundColor: theme.bgRaised,
    borderWidth: 0.7,
    borderColor: theme.line,
    borderRadius: radius.card,
    padding: 10,
    marginBottom: 8,
  },
  cardHead: { flexDirection: 'row' as const, alignItems: 'center' as const },
  cardGlyph: { color: theme.oceanBright, fontSize: 13, marginRight: 7 },
  cardName: { color: theme.text, fontSize: 13, fontWeight: '600' as const },
  cardArgs: {
    color: theme.text3,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 5,
  },
  cardOut: {
    backgroundColor: theme.fill,
    borderRadius: radius.output,
    padding: 8,
    marginTop: 6,
  },
  cardOutError: { backgroundColor: 'rgba(229, 72, 77, 0.12)' },
  cardOutLabel: { color: theme.text3, fontSize: 10, fontWeight: '700' as const, marginBottom: 2 },
  cardOutText: { color: theme.text2, fontSize: 12, lineHeight: 17 },
  chip: {
    borderRadius: 8,
    paddingLeft: 7,
    paddingRight: 7,
    paddingTop: 2,
    paddingBottom: 2,
    marginLeft: 8,
  },
  chipWait: { backgroundColor: 'rgba(255, 173, 31, 0.16)' },
  chipRun: { backgroundColor: 'rgba(46, 107, 230, 0.16)' },
  chipDone: { backgroundColor: 'rgba(46, 184, 92, 0.16)' },
  chipFail: { backgroundColor: 'rgba(229, 72, 77, 0.16)' },
  chipText: { fontSize: 11, fontWeight: '600' as const },
  chipTextWait: { color: theme.amber },
  chipTextRun: { color: theme.oceanBright },
  chipTextDone: { color: theme.green },
  chipTextFail: { color: theme.red },
  spinnerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.oceanBright,
    marginRight: 4,
  },

  // collapsible process group
  group: {
    backgroundColor: theme.fill,
    borderRadius: radius.card,
    padding: 9,
    marginBottom: 8,
  },
  groupHead: { flexDirection: 'row' as const, alignItems: 'center' as const },
  groupPreview: { color: theme.text2, fontSize: 13 },
  groupChevron: { color: theme.text3, fontSize: 11, marginLeft: 6 },
  groupBody: { marginTop: 8 },

  // status / system / creation rows
  statusRow: { flexDirection: 'row' as const, alignItems: 'center' as const, marginBottom: 8 },
  statusDot: { color: theme.text3, fontSize: 12, marginRight: 6 },
  statusText: { color: theme.text3, fontSize: 12 },
  statusWarn: { color: theme.amber },
  creationCard: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: theme.glassBg,
    borderWidth: 0.7,
    borderColor: theme.glassStroke,
    borderRadius: radius.card,
    padding: 10,
    marginBottom: 8,
  },
  creationGlyph: { fontSize: 15, marginRight: 8 },
  creationTitle: { color: theme.text, fontSize: 13, fontWeight: '600' as const },
  creationPath: { color: theme.text3, fontSize: 11, marginTop: 1 },

  // composer
  composer: {
    flexDirection: 'row' as const,
    alignItems: 'flex-end' as const,
    padding: 10,
    backgroundColor: theme.bg,
  },
  composerCard: {
    flex: 1,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: theme.glassBg,
    borderWidth: 0.7,
    borderColor: theme.glassStroke,
    borderRadius: radius.composer,
    paddingLeft: 14,
    paddingRight: 6,
    paddingTop: 4,
    paddingBottom: 4,
  },
  input: {
    flex: 1,
    color: theme.text,
    fontSize: 15,
    height: 38,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginLeft: 8,
    backgroundImage: gradient.send,
  },
  sendBtnStop: { backgroundImage: gradient.sendPressed },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' as const },

  // drawer
  drawerScrim: { ...absolutes, backgroundColor: 'rgba(6, 23, 43, 0.5)' },
  drawer: {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    bottom: 0,
    width: 286,
    backgroundColor: theme.bgRaised,
    borderRightWidth: 0.7,
    borderRightColor: theme.line,
    paddingTop: 18,
    paddingLeft: 14,
    paddingRight: 14,
  },
  drawerTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '700' as const,
    marginBottom: 12,
  },
  sessionRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: theme.fill,
    borderRadius: radius.menu,
    padding: 12,
    marginBottom: 8,
  },
  sessionMain: { flex: 1 },
  sessionTitle: { color: theme.text, fontSize: 14, fontWeight: '600' as const },
  sessionMeta: { color: theme.text3, fontSize: 11, marginTop: 2 },
  newSessionBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderRadius: radius.menu,
    borderWidth: 0.7,
    borderColor: theme.ocean,
    padding: 12,
    marginBottom: 10,
  },
  newSessionText: { color: theme.oceanBright, fontSize: 14, fontWeight: '600' as const },
};

export const CONNECTION_COLORS: Record<string, string> = {
  open: theme.green,
  connecting: theme.amber,
  closed: theme.red,
};

export const CONNECTION_LABELS: Record<string, string> = {
  open: '已连接',
  connecting: '连接中…',
  closed: '已断开',
};
