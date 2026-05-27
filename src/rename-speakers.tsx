import { Form, ActionPanel, Action, useNavigation } from "@raycast/api";
import { useState } from "react";
import { SpeakerNameMap } from "./types";

interface Props {
  speakers: string[]; // ["A", "B"]
  currentMap: SpeakerNameMap;
  onSubmit: (newMap: SpeakerNameMap) => void;
}

export function RenameSpeakersForm({ speakers, currentMap, onSubmit }: Props) {
  const { pop } = useNavigation();
  const [values, setValues] = useState<SpeakerNameMap>(() => ({ ...currentMap }));

  function handleChange(speaker: string, value: string) {
    setValues((prev) => ({ ...prev, [speaker]: value }));
  }

  function handleSubmit() {
    const cleaned: SpeakerNameMap = {};
    for (const [k, v] of Object.entries(values)) {
      if (v && v.trim()) cleaned[k] = v.trim();
    }
    onSubmit(cleaned);
    pop();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Apply Names" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      {speakers.map((s) => (
        <Form.TextField
          key={s}
          id={`speaker-${s}`}
          title={`Speaker ${s}`}
          placeholder={`Real name for Speaker ${s}`}
          value={values[s] || ""}
          onChange={(v) => handleChange(s, v)}
        />
      ))}
    </Form>
  );
}
