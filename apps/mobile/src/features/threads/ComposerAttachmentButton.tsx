import type { MenuAction } from "@react-native-menu/menu";
import { msg, useGT, useMessages } from "gt-react-native";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";

const MEDIA_MENU_ACTIONS: MenuAction[] = [
  { id: "camera", title: msg("Take Photo"), image: "camera" },
  { id: "photos", title: msg("Photo Library"), image: "photo" },
];
const FILES_MENU_ACTION: MenuAction = { id: "files", title: msg("Choose Files"), image: "folder" };

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly supportsFiles: boolean;
  readonly onPickMedia: (source?: "library" | "camera") => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
}) {
  const gt = useGT();
  const m = useMessages();
  const { scale } = useAndroidControlSizing();
  const button = (
    <Pressable
      accessibilityLabel={gt("Add attachment")}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
    >
      <SymbolView
        name="plus"
        size={Math.round((props.size === "large" ? 26 : 20) * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled) {
    return button;
  }

  return (
    <Menu
      accessible
      accessibilityLabel={gt("Add attachment")}
      accessibilityRole="button"
      actions={(props.supportsFiles
        ? [...MEDIA_MENU_ACTIONS, FILES_MENU_ACTION]
        : MEDIA_MENU_ACTIONS
      ).map((action) => ({ ...action, title: m(action.title) }))}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "camera") {
          void props.onPickMedia("camera");
        } else if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {button}
    </Menu>
  );
}
