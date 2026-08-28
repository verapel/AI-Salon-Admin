import { sanitizeDecimalInput, sanitizeIntegerInput } from '@/lib/numericInput';

interface NumericInputProps {
  value: string;
  onChange: (value: string) => void;
  integer?: boolean;
  placeholder?: string;
  required?: boolean;
  className?: string;
  id?: string;
  name?: string;
  'aria-label'?: string;
}

export default function NumericInput({
  value,
  onChange,
  integer = false,
  placeholder,
  required,
  className = 'input-field',
  id,
  name,
  'aria-label': ariaLabel,
}: NumericInputProps) {
  return (
    <input
      id={id}
      name={name}
      className={className}
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      pattern={integer ? '[0-9]*' : '[0-9]*[.,]?[0-9]*'}
      autoComplete="off"
      value={value}
      placeholder={placeholder}
      required={required}
      aria-label={ariaLabel}
      onChange={(e) =>
        onChange(integer ? sanitizeIntegerInput(e.target.value) : sanitizeDecimalInput(e.target.value))
      }
    />
  );
}
