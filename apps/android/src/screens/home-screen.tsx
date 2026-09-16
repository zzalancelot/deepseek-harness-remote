import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Animated,
  BackHandler,
  Dimensions,
  Easing,
  Keyboard,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Bot, Laptop, MoreVertical, Send } from 'lucide-react-native'
import { ChatScreen } from './chat-screen'
import { WorkspacesScreen, workspaceConnectionStatus } from './workspaces-screen'
import { resolveHomeWorkspace } from '../lib/last-workspace'
import { loadLastActiveWorkspaceId } from '../services/storage'
import { useAppStore } from '../state/store'
import { Button, ConnectionDrawerButton, EmptyState, IconButton, TopBar } from '../ui/components'
import { radius, spacing, type } from '../ui/theme'
import { useTheme, type ThemeColors } from '../ui/theme-context'
import { useThemedStyles } from '../ui/use-themed-styles'
import { strings as zhCN } from '../locales/i18n'

/** Wide enough to beat system gesture nav / child hit targets. */
const EDGE_WIDTH = 72
/** Keep clear of TopBar so the menu IconButton still receives taps. */
const EDGE_TOP_INSET = 64
const OPEN_DISTANCE = 28
const OPEN_VELOCITY = 0.15
const CLOSE_DISTANCE = 48
const CLOSE_VELOCITY = 0.2
const DRAWER_RATIO = 0.86
const DRAWER_MAX = 340
const ANIM_MS = 220

export function HomeScreen({
  onMore,
  onDeviceInfo,
  onDevices,
}: {
  onMore: () => void
  onDeviceInfo: () => void
  onDevices: () => void
}) {
  const connection = useAppStore(state => state.connection)
  const selectedDevice = useAppStore(state => state.selectedDevice)
  const selectedSession = useAppStore(state => state.selectedSession)
  const clearSelectedSession = useAppStore(state => state.clearSelectedSession)
  const connected = connection.phase === 'connected'
  const styles = useThemedStyles(createStyles)
  const screenWidth = Dimensions.get('window').width
  const drawerWidth = Math.min(DRAWER_MAX, Math.round(screenWidth * DRAWER_RATIO))

  const drawerX = useRef(new Animated.Value(-drawerWidth)).current
  const openRef = useRef(false)
  const animatingRef = useRef(false)
  const dragOrigin = useRef(-drawerWidth)
  const widthRef = useRef(drawerWidth)
  widthRef.current = drawerWidth
  /** Only drives pointerEvents — updated after animation to avoid mid-swipe remount flash. */
  const [drawerInteractive, setDrawerInteractive] = useState(false)

  useEffect(() => {
    if (animatingRef.current) return
    drawerX.setValue(openRef.current ? 0 : -drawerWidth)
  }, [drawerWidth, drawerX])

  const settle = useCallback((open: boolean) => {
    openRef.current = open
    animatingRef.current = true
    // Opening: allow touches once visible. Closing: keep layout stable until settled.
    if (open) setDrawerInteractive(true)
    Animated.timing(drawerX, {
      toValue: open ? 0 : -widthRef.current,
      duration: ANIM_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      animatingRef.current = false
      if (!finished) return
      setDrawerInteractive(open)
    })
  }, [drawerX])

  const openDrawer = useCallback(() => settle(true), [settle])
  const closeDrawer = useCallback(() => settle(false), [settle])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (openRef.current || drawerInteractive) {
        closeDrawer()
        return true
      }
      if (selectedSession !== undefined) {
        clearSelectedSession()
        return true
      }
      return false
    })
    return () => subscription.remove()
  }, [clearSelectedSession, closeDrawer, drawerInteractive, selectedSession])

  const beginDrag = useCallback(() => {
    animatingRef.current = true
    drawerX.stopAnimation(value => {
      dragOrigin.current = typeof value === 'number'
        ? value
        : (openRef.current ? 0 : -widthRef.current)
    })
  }, [drawerX])

  const moveDrag = useCallback((dx: number) => {
    const width = widthRef.current
    drawerX.setValue(Math.min(0, Math.max(-width, dragOrigin.current + dx)))
  }, [drawerX])

  const endDrag = useCallback((dx: number, vx: number) => {
    const width = widthRef.current
    const current = Math.min(0, Math.max(-width, dragOrigin.current + dx))
    const opening = dragOrigin.current < -width * 0.5
    if (opening) {
      settle(dx > OPEN_DISTANCE || vx > OPEN_VELOCITY || current > -width * 0.55)
      return
    }
    settle(!(dx < -CLOSE_DISTANCE || vx < -CLOSE_VELOCITY || current < -width * 0.45))
  }, [settle])

  /** Left-edge capture: wins over TopBar / composer children. */
  const edgePan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !openRef.current,
    onStartShouldSetPanResponderCapture: () => !openRef.current,
    onMoveShouldSetPanResponder: (_e, g) => !openRef.current && g.dx > 4,
    onMoveShouldSetPanResponderCapture: (_e, g) => !openRef.current && g.dx > 4,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: beginDrag,
    onPanResponderMove: (_e, g) => moveDrag(g.dx),
    onPanResponderRelease: (_e, g) => endDrag(g.dx, g.vx),
    onPanResponderTerminate: (_e, g) => endDrag(g.dx, g.vx),
  }), [beginDrag, endDrag, moveDrag])

  /** Scrim / open drawer: drag closed. */
  const closePan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) =>
      openRef.current && Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderGrant: beginDrag,
    onPanResponderMove: (_e, g) => moveDrag(g.dx),
    onPanResponderRelease: (_e, g) => endDrag(g.dx, g.vx),
    onPanResponderTerminate: (_e, g) => endDrag(g.dx, g.vx),
  }), [beginDrag, endDrag, moveDrag])

  /** Empty new-chat body: swipe right to open. */
  const contentOpenPan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) =>
      !openRef.current
      && g.dx > 12
      && Math.abs(g.dx) > Math.abs(g.dy) * 1.1,
    onPanResponderGrant: beginDrag,
    onPanResponderMove: (_e, g) => moveDrag(g.dx),
    onPanResponderRelease: (_e, g) => endDrag(g.dx, g.vx),
    onPanResponderTerminate: (_e, g) => endDrag(g.dx, g.vx),
  }), [beginDrag, endDrag, moveDrag])

  const scrimOpacity = useMemo(() => drawerX.interpolate({
    inputRange: [-drawerWidth, 0],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  }), [drawerWidth, drawerX])

  if (!connected) {
    return (
      <View style={styles.flex}>
        <TopBar
          title="DSH Remote"
          action={<IconButton label={zhCN.settings.more} icon={MoreVertical} onPress={onMore} />}
        />
        <View style={styles.emptyWrap}>
          <EmptyState
            icon={Laptop}
            title={zhCN.home.noDeviceTitle}
            body={zhCN.home.noDeviceBody}
            action={<Button label={zhCN.home.chooseDevice} onPress={onDevices} />}
          />
        </View>
      </View>
    )
  }

  const connectionStatusLabel = workspaceConnectionStatus(connection.phase, connection.stats.mode)
  const deviceTitle = selectedDevice?.name ?? zhCN.workspaces.noDevice

  return (
    <View style={styles.flex}>
      <View style={styles.flex}>
        {selectedSession === undefined
          ? (
            <NewChatPanel
              onOpenDrawer={openDrawer}
              onMore={onMore}
              onNeedWorkspace={openDrawer}
              bodyPanHandlers={contentOpenPan.panHandlers}
            />
          )
          : (
            <ChatScreen
              homeMode
              onOpenDrawer={openDrawer}
              onMore={onMore}
              onNewChat={() => clearSelectedSession()}
            />
          )}
      </View>

      {/* Always mounted — toggling this view caused a one-frame flash. */}
      <View
        style={styles.edgeHit}
        collapsable={false}
        pointerEvents={drawerInteractive ? 'none' : 'auto'}
        {...edgePan.panHandlers}
      />

      <Animated.View
        pointerEvents={drawerInteractive ? 'auto' : 'none'}
        collapsable={false}
        style={[styles.scrim, { opacity: scrimOpacity }]}
        {...closePan.panHandlers}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={zhCN.home.closeWorkspaces}
          style={StyleSheet.absoluteFill}
          onPress={closeDrawer}
        />
      </Animated.View>

      <Animated.View
        collapsable={false}
        style={[
          styles.drawer,
          { width: drawerWidth, transform: [{ translateX: drawerX }] },
        ]}
        pointerEvents={drawerInteractive ? 'auto' : 'none'}
        {...closePan.panHandlers}
      >
        <WorkspacesScreen
          drawerTitle={deviceTitle}
          drawerSubtitle={connectionStatusLabel}
          onSession={() => closeDrawer()}
          onDeviceInfo={() => {
            closeDrawer()
            onDeviceInfo()
          }}
        />
      </Animated.View>
    </View>
  )
}

function NewChatPanel({
  onOpenDrawer,
  onMore,
  onNeedWorkspace,
  bodyPanHandlers,
}: {
  onOpenDrawer: () => void
  onMore: () => void
  onNeedWorkspace: () => void
  bodyPanHandlers?: object
}) {
  const workspaces = useAppStore(state => state.workspaces)
  const selectedDevice = useAppStore(state => state.selectedDevice)
  const connection = useAppStore(state => state.connection)
  const createSession = useAppStore(state => state.createSession)
  const sendMessage = useAppStore(state => state.sendMessage)
  const busy = useAppStore(state => state.busyAction)
  const [draft, setDraft] = useState('')
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const sending = busy === 'create-session' || busy === 'send-message'

  const submit = async () => {
    const text = draft.trim()
    if (text.length === 0 || sending) return
    const deviceId = selectedDevice?.deviceId
    const lastId = deviceId === undefined ? undefined : await loadLastActiveWorkspaceId(deviceId)
    const workspace = resolveHomeWorkspace(workspaces, lastId)
    if (workspace === undefined) {
      Alert.alert(zhCN.home.noWorkspaceTitle, zhCN.home.noWorkspaceBody, [
        { text: zhCN.common.cancel, style: 'cancel' },
        { text: zhCN.home.createWorkspace, onPress: onNeedWorkspace },
      ])
      return
    }
    setDraft('')
    Keyboard.dismiss()
    if (!await createSession(workspace.workspaceId)) {
      setDraft(text)
      return
    }
    if (!await sendMessage(text)) setDraft(text)
  }

  return (
    <View style={styles.flex}>
      <TopBar
        title={zhCN.home.title}
        leading={(
          <ConnectionDrawerButton
            connected={connection.phase === 'connected'}
            onPress={onOpenDrawer}
          />
        )}
        action={<IconButton label={zhCN.settings.more} icon={MoreVertical} onPress={onMore} />}
      />
      <View style={styles.newChatBody} {...bodyPanHandlers}>
        <View style={styles.welcome}>
          <View style={styles.welcomeIcon}><Bot size={25} color={colors.primary} /></View>
          <Text style={styles.welcomeTitle}>{zhCN.home.newChatWelcomeTitle}</Text>
          <Text style={styles.welcomeBody}>{zhCN.home.newChatWelcomeBody}</Text>
        </View>
      </View>
      <View style={styles.composerWrap}>
        <View style={styles.composer}>
          <TextInput
            accessibilityLabel={zhCN.chat.messageLabel}
            style={styles.composerInput}
            value={draft}
            onChangeText={setDraft}
            placeholder={zhCN.chat.placeholder}
            placeholderTextColor={colors.muted}
            multiline
            maxLength={12_000}
            editable={!sending}
            selectionColor={colors.accent}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={zhCN.chat.send}
            disabled={sending || draft.trim().length === 0}
            onPress={() => void submit()}
            style={({ pressed }) => [
              styles.sendButton,
              pressed && styles.sendPressed,
              (sending || draft.trim().length === 0) && styles.sendDisabled,
            ]}
          >
            <Send size={19} color={colors.white} />
          </Pressable>
        </View>
        <Text style={styles.composerHint}>{zhCN.chat.policyHint}</Text>
      </View>
    </View>
  )
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.background },
    edgeHit: {
      position: 'absolute',
      top: EDGE_TOP_INSET,
      bottom: 0,
      left: 0,
      width: EDGE_WIDTH,
      zIndex: 5,
    },
    scrim: {
      ...StyleSheet.absoluteFill,
      backgroundColor: colors.modalBackdrop,
      zIndex: 3,
    },
    drawer: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      zIndex: 4,
      backgroundColor: colors.background,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: colors.separator,
      // Avoid elevation while closed — Android elevation can flash when pointerEvents flips.
      elevation: 0,
    },
    emptyWrap: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
    newChatBody: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.xl },
    welcome: { alignItems: 'center', gap: spacing.sm },
    welcomeIcon: {
      width: 52,
      height: 52,
      borderRadius: radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceStrong,
      marginBottom: spacing.xs,
    },
    welcomeTitle: { ...type.title, color: colors.ink, textAlign: 'center' },
    welcomeBody: { ...type.body, color: colors.muted, textAlign: 'center' },
    composerWrap: {
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.separator,
      backgroundColor: colors.background,
    },
    composer: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.xs,
      marginTop: spacing.sm,
    },
    composerInput: {
      flex: 1,
      maxHeight: 120,
      ...type.body,
      color: colors.ink,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    sendButton: {
      width: 40,
      height: 40,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primary,
    },
    sendPressed: { opacity: 0.85 },
    sendDisabled: { opacity: 0.4 },
    composerHint: { ...type.small, color: colors.subtle, marginTop: spacing.xs, textAlign: 'center' },
  })
}
