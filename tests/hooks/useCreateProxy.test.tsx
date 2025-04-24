import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, it, expect, beforeEach, MockInstance, vi } from 'vitest';
import delay from 'delay';

import { useCreateProxy } from '../../source/hooks/useCreateProxy.js';
import { validateProxyConfig } from '../../source/utils/api/proxy/createutils.js';

// ——— Mocks ———
const mockPost = vi.fn();
const mockApiClient = { POST: mockPost };
const mockAuthClient = vi.fn(() => mockApiClient);
const mockUnAuthClient = vi.fn((key: string) => mockApiClient);

vi.mock('../../source/hooks/useClient.js', () => ({
	default: () => ({
		authenticatedApiClient: mockAuthClient,
		unAuthenticatedApiClient: mockUnAuthClient,
	}),
}));

vi.mock('../../source/utils/api/proxy/createutils.js', () => ({
	validateProxyConfig: vi.fn(),
}));

// ——— Test helper ———
function createTestComponent(
	projectId?: string,
	environmentId?: string,
	apiKey?: string,
) {
	let hookValues: any = {};
	const Test = () => {
		hookValues = useCreateProxy();
		return (
			<Text>{`Status: ${hookValues.status}, Error: ${hookValues.errorMessage ?? 'none'}`}</Text>
		);
	};
	return {
		TestComponent: Test,
		getHook: () => hookValues,
	};
}

describe('useCreateProxy', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockPost.mockReset();
		(validateProxyConfig as unknown as MockInstance).mockImplementation(
			() => undefined,
		);
	});

	it('has initial state processing + no error', () => {
		const { TestComponent, getHook } = createTestComponent('proj', 'env');
		render(<TestComponent />);
		const h = getHook();
		expect(h.status).toBe('processing');
		expect(h.errorMessage).toBeNull();
	});

	it('errors when projectId/envId missing', async () => {
		const { TestComponent, getHook } = createTestComponent(undefined, 'env');
		render(<TestComponent />);
		await getHook().createProxy({ key: 'k', mapping_rules: [] });
		await delay(50);
		const h = getHook();
		expect(h.status).toBe('error');
		expect(h.errorMessage).toMatch(/Cannot read properties of undefined/);
	});

	it('handles validation util throwing', async () => {
		(validateProxyConfig as unknown as MockInstance).mockImplementation(() => {
			throw new Error('Bad payload');
		});
		const { TestComponent, getHook } = createTestComponent('p', 'e');
		render(<TestComponent />);
		await getHook().createProxy({ key: 'k', mapping_rules: [] });
		await delay(50);
		const h = getHook();
		expect(h.status).toBe('error');
		expect(h.errorMessage).toBe('Bad payload');
	});

	it('successfully creates a proxy (2xx)', async () => {
		mockPost.mockResolvedValue({ response: { status: 201 }, error: null });
		const { TestComponent, getHook } = createTestComponent('p', 'e');
		const rendered = render(<TestComponent />);

		await getHook().createProxy({ key: 'k', mapping_rules: [] });
		await delay(50);

		expect(mockPost).toHaveBeenCalled();
		const h = getHook();
		expect(h.status).toBe('done');
		expect(h.errorMessage).toBeNull();

		rendered.rerender(<TestComponent />);
		expect(rendered.lastFrame()).toContain('Status: done');
	});

	it('handles 422 validation errors from API', async () => {
		mockPost.mockResolvedValue({
			response: { status: 422 },
			error: { message: 'Invalid schema' },
		});
		const { TestComponent, getHook } = createTestComponent('p', 'e');
		render(<TestComponent />);

		await getHook().createProxy({ key: 'k', mapping_rules: [] });
		await delay(50);

		const h = getHook();
		expect(h.status).toBe('error');
		expect(h.errorMessage).toBe('Invalid schema');
	});

	it('handles unexpected status codes', async () => {
		mockPost.mockResolvedValue({
			response: { status: 400 },
			error: { foo: 'bar' },
		});
		const { TestComponent, getHook } = createTestComponent('p', 'e');
		render(<TestComponent />);

		await getHook().createProxy({ key: 'k', mapping_rules: [] });
		await delay(50);

		const h = getHook();
		expect(h.status).toBe('error');
		expect(h.errorMessage).toContain(
			'Unexpected API status code: 400: {"foo":"bar"}',
		);
	});

	it('catches thrown Error instances', async () => {
		mockPost.mockImplementation(() => {
			throw new Error('Network fail');
		});
		const { TestComponent, getHook } = createTestComponent('p', 'e');
		render(<TestComponent />);

		await getHook().createProxy({ key: 'k', mapping_rules: [] });
		await delay(50);

		const h = getHook();
		expect(h.status).toBe('error');
		expect(h.errorMessage).toBe('Network fail');
	});

	it('catches non-Error throws', async () => {
		mockPost.mockImplementation(() => {
			throw 'String error';
		});
		const { TestComponent, getHook } = createTestComponent('p', 'e');
		render(<TestComponent />);

		await getHook().createProxy({ key: 'k', mapping_rules: [] });
		await delay(50);

		const h = getHook();
		expect(h.status).toBe('error');
		expect(h.errorMessage).toBe('String error');
	});

	it('uses authenticated client regardless of apiKey', async () => {
		mockPost.mockResolvedValue({ response: { status: 200 }, error: null });
		const { TestComponent, getHook } = createTestComponent(
			'p',
			'e',
			'my-api-key',
		);
		render(<TestComponent />);

		await getHook().createProxy({ key: 'k', mapping_rules: [] });
		await delay(50);

		expect(mockAuthClient).toHaveBeenCalled();
		expect(mockUnAuthClient).not.toHaveBeenCalled();
	});

	it('formatErrorMessage returns input unchanged', () => {
		const { TestComponent, getHook } = createTestComponent('p', 'e');
		render(<TestComponent />);
		const msg = getHook().formatErrorMessage('Some message');
		expect(msg).toBe('Some message');
	});

	it('allows direct state control with setters', async () => {
		const { TestComponent, getHook } = createTestComponent('p', 'e');
		const r = render(<TestComponent />);

		getHook().setStatus('input');
		await delay(20);
		r.rerender(<TestComponent />);
		expect(r.lastFrame()).toContain('Status: input');

		getHook().setErrorMessage('Oops');
		await delay(20);
		r.rerender(<TestComponent />);
		expect(r.lastFrame()).toContain('Error: Oops');
	});
});
