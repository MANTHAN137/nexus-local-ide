import Editor, {DiffEditor} from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === "json"
      ? new JsonWorker()
      : ["typescript", "javascript"].includes(label)
        ? new TsWorker()
        : new EditorWorker(),
};
loader.config({ monaco });
monaco.editor.defineTheme("nexus", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "65766F", fontStyle: "italic" },
    { token: "keyword", foreground: "BAABE6" },
    { token: "string", foreground: "C6D7A0" },
    { token: "type.identifier", foreground: "9ECBC5" },
    { token: "number", foreground: "D8B58C" },
  ],
  colors: {
    "editor.background": "#17191c",
    "editor.foreground": "#ccd1d6",
    "editorLineNumber.foreground": "#50565d",
    "editorLineNumber.activeForeground": "#c0c8cf",
    "editor.lineHighlightBackground": "#1d2024",
    "editor.selectionBackground": "#344a42",
    "editorCursor.foreground": "#b5e6cb",
    "editorIndentGuide.background1": "#262b2d",
    "editorWidget.background": "#202428",
    "editorWidget.border": "#363e42",
    "scrollbarSlider.background": "#4a545440",
  },
});

export {Editor,DiffEditor};
