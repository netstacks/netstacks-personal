import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { claudeIgnoresTemperature, TEMPERATURE_IGNORED_NOTE } from '../modelTemperature'
import { AgentDefinitionForm } from '../../components/AgentDefinitionForm'

describe('claudeIgnoresTemperature', () => {
  it.each([
    'claude-opus-5', 'claude-opus-4-7', 'claude-opus-4-8-20261001', 'claude-sonnet-5',
    'us.anthropic.claude-sonnet-5-v1:0', 'anthropic/claude-opus-5', 'claude-fable', 'fable',
  ])('%s ignores temperature', (id) => expect(claudeIgnoresTemperature(id)).toBe(true))

  it.each([
    '', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-sonnet-4-5', 'claude-3-opus-20240229',
    'claude-3-5-sonnet-20241022', 'claude-haiku-4-5', 'gpt-4o', 'llama3:8b',
  ])('%s accepts temperature', (id) => expect(claudeIgnoresTemperature(id)).toBe(false))
})

describe('AgentDefinitionForm temperature note', () => {
  it('always explains the limitation and calls out an affected model', () => {
    render(<AgentDefinitionForm onSave={vi.fn(async () => {})} onCancel={() => {}} isSaving={false} />)
    expect(screen.getByText(TEMPERATURE_IGNORED_NOTE)).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Use default'), { target: { value: 'claude-opus-5' } })
    expect(screen.getByText(/claude-opus-5 doesn.t support temperature, so this is ignored/)).toBeInTheDocument()
  })
})
