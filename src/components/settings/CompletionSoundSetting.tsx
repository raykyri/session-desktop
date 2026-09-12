import { Volume2 } from "lucide-react";
import { COMPLETION_SOUND_OPTIONS, type CompletionSoundId } from "../../lib/completionSounds";

interface CompletionSoundSettingProps {
  value: CompletionSoundId;
  onChange: (sound: CompletionSoundId) => void;
  onPreview: (sound: CompletionSoundId) => void;
}

export function CompletionSoundSetting({ value, onChange, onPreview }: CompletionSoundSettingProps) {
  return (
    <div className="settings-row">
      <label htmlFor="settings-completion-sound" className="settings-label">
        Completion sound
      </label>
      <div className="settings-completion-sound-controls">
        <select
          id="settings-completion-sound"
          className="settings-select settings-completion-sound-select"
          value={value}
          onChange={(event) => {
            const sound = event.currentTarget.value as CompletionSoundId;
            onChange(sound);
            onPreview(sound);
          }}
        >
          {COMPLETION_SOUND_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="control-button settings-completion-sound-test"
          onClick={() => onPreview(value)}
        >
          <Volume2 size={14} aria-hidden="true" />
          Test
        </button>
      </div>
    </div>
  );
}
