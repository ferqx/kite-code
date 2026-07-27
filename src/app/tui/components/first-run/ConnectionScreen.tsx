import { ApiKeyForm } from './ApiKeyForm';
import { CustomEndpointForm } from './CustomEndpointForm';
import type { ConnectionFormState, ProviderDefinition } from './types';

interface ConnectionScreenProps {
  provider: ProviderDefinition;
  form: ConnectionFormState;
  editingField?: string;
  error?: string;
  onEditingFieldChange: (field?: string) => void;
  onCancelEdit: (field: string, restoreValue: string) => void;
  onSubmit: (apiKey: string, baseURL: string) => void;
  onBack: () => void;
  onUpdateField: (field: keyof ConnectionFormState, value: string) => void;
}

export default function ConnectionScreen({
  provider,
  form,
  editingField,
  error,
  onEditingFieldChange,
  onCancelEdit,
  onSubmit,
  onBack,
  onUpdateField,
}: ConnectionScreenProps) {
  if (provider.connectionForm === 'api-key') {
    return (
      <ApiKeyForm
        providerLabel={provider.label}
        apiKey={form.apiKey}
        error={error}
        onUpdate={(v) => onUpdateField('apiKey', v)}
        onSubmit={(value) => onSubmit(value, form.baseURL || provider.defaultBaseURL)}
        onBack={onBack}
      />
    );
  }

  return (
    <CustomEndpointForm
      provider={provider}
      form={form}
      editingField={editingField}
      error={error}
      onEditingFieldChange={onEditingFieldChange}
      onCancelEdit={onCancelEdit}
      onSubmit={() => onSubmit(form.apiKey, form.baseURL || provider.defaultBaseURL)}
      onBack={onBack}
      onUpdateField={onUpdateField}
    />
  );
}
