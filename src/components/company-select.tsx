"use client";
import { useApi } from "./api";
import type { Company } from "./types";
import { Button, Field, Select, Notice } from "./ui";

export function CompanySelect({
  id = "company",
  value,
  onChange,
  disabled = false,
  required = true,
}: {
  id?: string;
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const state = useApi<{ companies: Company[] }>("/api/companies");
  const companies = state.data?.companies ?? [];
  const isDemoOption = (company: Company) => /^\s*\[DEMO\]/i.test(company.name);
  const selectedDemo = companies.find(
    (company) => company.id === value && isDemoOption(company),
  );
  return (
    <>
      <Field label="Company" htmlFor={id} required={required}>
        <Select
          id={id}
          name="companyId"
          required={required}
          disabled={disabled || state.loading}
          value={value}
          onChange={
            onChange ? (event) => onChange(event.target.value) : undefined
          }
          defaultValue={value === undefined ? "" : undefined}
        >
          <option value="">
            {required ? "Select company" : "All authorized companies"}
          </option>
          {/* Preserve the company identity of existing bills and OCR reviews. */}
          {selectedDemo && (
            <option value={selectedDemo.id} hidden disabled>
              {selectedDemo.name}
            </option>
          )}
          {companies.filter((company) => !isDemoOption(company)).map((company) => (
            <option key={company.id} value={company.id}>
              {company.name.replace(/^\s*\[CONNECTION CHECK\]\s*/i, "")}
            </option>
          ))}
        </Select>
      </Field>
      {state.error && <Notice tone="error">
        <p>{state.error}</p>
        <Button type="button" variant="secondary" size="sm" onClick={state.reload}>Retry companies</Button>
      </Notice>}
    </>
  );
}
