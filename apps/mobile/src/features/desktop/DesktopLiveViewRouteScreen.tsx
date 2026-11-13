import type { StaticScreenProps } from "@react-navigation/native";
import type {
  DesktopStreamStatus,
  PreviewStreamControl,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { PreviewStreamWebView, type PreviewStreamRef } from "../browser/PreviewStreamWebView";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

type DesktopLiveViewRouteScreenProps = StaticScreenProps<{ readonly environmentId: string }>;

const STATUS_MESSAGES: Record<Exclude<DesktopStreamStatus["state"], "streaming">, string> = {
  unverified: "Screen sharing has not worked on this machine yet.",
  starting: "Starting the screen capture...",
  consent: "Waiting for someone at the machine to allow screen sharing. This is asked once.",
  denied: "Screen sharing was declined on the machine.",
  ended: "Screen sharing was stopped on the machine.",
  unavailable: "This machine cannot share its screen right now.",
};

const KEYS = [
  { label: "Enter", key: "Enter", code: "Enter" },
  { label: "Tab", key: "Tab", code: "Tab" },
  { label: "Esc", key: "Escape", code: "Escape" },
  { label: "Delete", key: "Backspace", code: "Backspace" },
] as const;

/** A machine's whole screen; take control to type a password or answer a system prompt. */
export function DesktopLiveViewRouteScreen({ route }: DesktopLiveViewRouteScreenProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const stream = useRef<PreviewStreamRef>(null);
  const [status, setStatus] = useState<DesktopStreamStatus | null>(null);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const [text, setText] = useState("");
  // Hidden by default: what is typed here is often a password.
  const [hidden, setHidden] = useState(true);
  const driving = control?.controller === "you";
  const pressKey = (key: string, code: string) => {
    stream.current?.command({ type: "key", action: "down", key, code, modifiers: 0 });
    stream.current?.command({ type: "key", action: "up", key, code, modifiers: 0 });
  };
  const sendText = () => {
    if (!text) return;
    stream.current?.command({ type: "text", text });
    setText("");
  };

  return (
    <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
      {status && status.state !== "streaming" ? (
        <View className="items-center gap-3 border-b border-secondary-border px-4 py-3">
          <AppText selectable className="text-center text-sm text-foreground-muted">
            {status.detail ?? STATUS_MESSAGES[status.state]}
          </AppText>
          {status.state === "unverified" ? (
            <Button
              label="Start screen sharing anyway"
              tone="danger"
              onPress={() => stream.current?.command({ type: "reload" })}
            />
          ) : null}
          {status.state === "denied" ||
          status.state === "ended" ||
          status.state === "unavailable" ? (
            <Button
              label="Try again"
              tone="secondary"
              onPress={() => stream.current?.command({ type: "reload" })}
            />
          ) : null}
        </View>
      ) : null}
      <PreviewStreamWebView
        ref={stream}
        environmentId={environmentId}
        threadId="desktop"
        tabId="desktop"
        stream="desktop"
        interactive
        background={themeVariables["--color-sheet-solid"]}
        onDesktop={setStatus}
        onControl={setControl}
      />
      {driving ? (
        <View className="gap-2 border-t border-secondary-border px-3 py-2">
          <View className="flex-row items-center gap-2">
            <TextInput
              accessibilityLabel="Type on the desktop"
              className="flex-1 rounded-lg border border-input-border bg-input px-3 py-2 text-foreground"
              placeholder="Type on the desktop"
              placeholderTextColorClassName="accent-placeholder"
              selectionColorClassName="accent-focus/32"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={hidden}
              value={text}
              onChangeText={setText}
              onSubmitEditing={sendText}
              returnKeyType="send"
            />
            <Button
              label={hidden ? "Show" : "Hide"}
              tone="text"
              size="compact"
              onPress={() => setHidden((current) => !current)}
            />
            <Button label="Send" tone="secondary" size="compact" onPress={sendText} />
          </View>
          <View className="flex-row flex-wrap gap-2">
            {KEYS.map((entry) => (
              <Button
                key={entry.code}
                label={entry.label}
                tone="secondary"
                size="compact"
                onPress={() => pressKey(entry.key, entry.code)}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
