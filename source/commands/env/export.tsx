import React from 'react';
import { Text } from 'ink';
import { option } from 'pastel';
import zod from 'zod';
import fs from 'node:fs/promises';
import Spinner from 'ink-spinner';
import { useApiKeyApi } from '../../hooks/useApiKeyApi.js';
import { AuthProvider, useAuth } from '../../components/AuthProvider.js';
import { Permit } from 'permitio';

export const options = zod.object({
	key: zod
		.string()
		.optional()
		.describe(
			option({
				description: 'API Key to be used for the environment export',
				alias: 'k',
			}),
		),
	file: zod
		.string()
		.optional()
		.describe(
			option({
				description: 'File path to save the exported HCL content',
				alias: 'f',
			}),
		),
});

type Props = {
	readonly options: zod.infer<typeof options>;
};

interface ExportState {
	status: string;
	isComplete: boolean;
	error: string | null;
	warnings: string[];
}

function createSafeId(...parts: string[]): string {
	return parts
		.map(part => (part || '').replace(/[^a-zA-Z0-9_]/g, '_'))
		.filter(Boolean)
		.join('_');
}

const ExportContent: React.FC<Props> = ({ options: { key: apiKey, file } }) => {
	const [state, setState] = React.useState<ExportState>({
		status: '',
		isComplete: false,
		error: null,
		warnings: [],
	});

	const { validateApiKeyScope } = useApiKeyApi();
	const { authToken } = useAuth();
	const key = apiKey || authToken;

	const addWarning = (warning: string) => {
		setState(prev => ({
			...prev,
			warnings: [...prev.warnings, warning],
			status: `Warning: ${warning}`,
		}));
	};

	React.useEffect(() => {
		let isSubscribed = true;

		const exportConfig = async () => {
			if (!key) {
				setState(prev => ({
					...prev,
					error: 'No API key provided. Please provide a key or login first.',
					isComplete: true,
				}));
				return;
			}

			try {
				setState(prev => ({ ...prev, status: 'Validating API key...' }));
				const {
					valid,
					error: scopeError,
					scope,
				} = await validateApiKeyScope(key, 'environment');
				if (!valid || scopeError) {
					setState(prev => ({
						...prev,
						error: `Invalid API key: ${scopeError}`,
						isComplete: true,
					}));
					return;
				}

				if (!isSubscribed) return;

				setState(prev => ({
					...prev,
					status: 'Initializing Permit client...',
				}));
				const permit = new Permit({
					token: key,
					pdp: 'http://localhost:7766',
				});

				let hcl = `# Generated by Permit CLI
# Environment: ${scope?.environment_id || 'unknown'}
# Project: ${scope?.project_id || 'unknown'}
# Organization: ${scope?.organization_id || 'unknown'}

terraform {
  required_providers {
    permitio = {
      source = "permitio/permit-io"
      version = "~> 0.1.0"
    }
  }
}

provider "permitio" {
  api_key = "${key}"
}\n`;

				// Export Resources
				setState(prev => ({ ...prev, status: 'Exporting resources...' }));
				const resources = await permit.api.resources.list();
				const validResources = resources.filter(
					resource => resource.key !== '__user',
				);
				if (validResources.length > 0) {
					hcl += '\n# Resources\n';
					for (const resource of validResources) {
						hcl += `resource "permitio_resource" "${createSafeId(resource.key)}" {
  key  = "${resource.key}"
  name = "${resource.name}"${
		resource.description
			? `
  description = "${resource.description}"`
			: ''
	}${
		resource.urn
			? `
  urn = "${resource.urn}"`
			: ''
	}
  actions = {${Object.entries(resource.actions)
		.map(
			([actionKey, action]) => `
    "${actionKey}" = {
      name = "${action.name}"${
				action.description
					? `
      description = "${action.description}"`
					: ''
			}
    }`,
		)
		.join('')}
  }${
		resource.attributes && Object.keys(resource.attributes).length > 0
			? `
  attributes = {${Object.entries(resource.attributes)
		.map(
			([attrKey, attr]) => `
    "${attrKey}" = {
      type = "${attr.type}"${
				attr.description
					? `
      description = "${attr.description}"`
					: ''
			}
    }`,
		)
		.join('')}
  }`
			: ''
	}
}\n`;
					}
				}

				// Export Resource Relations
				setState(prev => ({
					...prev,
					status: 'Exporting resource relations...',
				}));
				try {
					for (const resource of validResources) {
						const relations = await permit.api.resourceRelations.list({
							resourceKey: resource.key,
						});
						if (relations && relations.length > 0) {
							hcl += `\n# Resource Relations for ${resource.key}\n`;
							for (const relation of relations) {
								const safeId = createSafeId(resource.key, relation.key);
								hcl += `resource "permitio_relation" "${safeId}" {
  key = "${relation.key}"
  name = "${relation.name}"
  subject_resource = "${resource.key}"
  object_resource = "${relation.object_resource}"${
		relation.description
			? `
  description = "${relation.description}"`
			: ''
	}
}\n`;
							}
						}
					}
				} catch (error) {
					addWarning(`Failed to export resource relations: ${error}`);
				}

				// Export Roles
				setState(prev => ({ ...prev, status: 'Exporting roles...' }));
				try {
					const roles = await permit.api.roles.list();
					if (roles && roles.length > 0) {
						hcl += '\n# Roles\n';
						for (const role of roles) {
							hcl += `resource "permitio_role" "${createSafeId(role.key)}" {
  key  = "${role.key}"
  name = "${role.name}"${
		role.description
			? `
  description = "${role.description}"`
			: ''
	}${
		role.permissions && role.permissions.length > 0
			? `
  permissions = ${JSON.stringify(role.permissions)}`
			: ''
	}${
		role.extends && role.extends.length > 0
			? `
  extends = ${JSON.stringify(role.extends)}`
			: ''
	}
}\n`;
						}
					}
				} catch (error) {
					addWarning(`Failed to export roles: ${error}`);
				}

				// Export User Attributes
				setState(prev => ({ ...prev, status: 'Exporting user attributes...' }));
				try {
					const userAttributes = await permit.api.resourceAttributes.list({
						resourceKey: '__user',
					});
					if (userAttributes && userAttributes.length > 0) {
						hcl += '\n# User Attributes\n';
						for (const attr of userAttributes) {
							hcl += `resource "permitio_user_attribute" "${createSafeId(attr.key)}" {
  key = "${attr.key}"
  type = "${attr.type}"${
		attr.description
			? `
  description = "${attr.description}"`
			: ''
	}
}\n`;
						}
					}
				} catch (error) {
					addWarning(`Failed to export user attributes: ${error}`);
				}

				// Export Condition Sets
				setState(prev => ({ ...prev, status: 'Exporting condition sets...' }));
				try {
					const conditionSets = await permit.api.conditionSets.list();

					// Export User Sets
					const userSets = conditionSets.filter(set => set.type === 'userset');
					if (userSets.length > 0) {
						hcl += '\n# User Sets\n';
						for (const set of userSets) {
							if (!set.key || !set.name) {
								addWarning(`Invalid user set data: ${JSON.stringify(set)}`);
								continue;
							}
							hcl += `resource "permitio_user_set" "${createSafeId(set.key)}" {
  key = "${set.key}"
  name = "${set.name}"${
		set.description
			? `
  description = "${set.description}"`
			: ''
	}
  conditions = jsonencode(${JSON.stringify(set.conditions || {}, null, 2)})
}\n`;
						}
					}

					// Export Resource Sets
					const resourceSets = conditionSets.filter(
						set => set.type === 'resourceset',
					);
					if (resourceSets.length > 0) {
						hcl += '\n# Resource Sets\n';
						for (const set of resourceSets) {
							if (!set.key || !set.name || !set.resource_id) {
								addWarning(`Invalid resource set data: ${JSON.stringify(set)}`);
								continue;
							}
							hcl += `resource "permitio_resource_set" "${createSafeId(set.key)}" {
  key = "${set.key}"
  name = "${set.name}"${
		set.description
			? `
  description = "${set.description}"`
			: ''
	}
  resource = "${set.resource_id}"
  conditions = jsonencode(${JSON.stringify(set.conditions || {}, null, 2)})
}\n`;
						}
					}

					// Export Condition Set Rules
					setState(prev => ({
						...prev,
						status: 'Exporting condition set rules...',
					}));
					const conditionSetRules = await permit.api.conditionSetRules.list({
						userSetKey: '',
						permissionKey: '',
						resourceSetKey: '',
					});

					if (conditionSetRules && conditionSetRules.length > 0) {
						hcl += '\n# Condition Set Rules\n';
						for (const rule of conditionSetRules) {
							if (!rule.user_set || !rule.permission || !rule.resource_set) {
								addWarning(
									`Invalid condition set rule: ${JSON.stringify(rule)}`,
								);
								continue;
							}
							const safeId = createSafeId(
								rule.user_set,
								rule.permission,
								rule.resource_set,
							);
							hcl += `resource "permitio_condition_set_rule" "${safeId}" {
  user_set = "${rule.user_set}"
  permission = "${rule.permission}"
  resource_set = "${rule.resource_set}"
}\n`;
						}
					}
				} catch (error) {
					addWarning(`Failed to export condition sets: ${error}`);
				}

				if (!isSubscribed) return;

				// Save or print output
				if (file) {
					setState(prev => ({ ...prev, status: 'Saving to file...' }));
					await fs.writeFile(file, hcl);
				} else {
					console.log(hcl);
				}

				if (!isSubscribed) return;
				setState(prev => ({ ...prev, isComplete: true }));
			} catch (err) {
				if (!isSubscribed) return;
				const errorMsg = err instanceof Error ? err.message : String(err);
				setState(prev => ({
					...prev,
					error: `Failed to export configuration: ${errorMsg}`,
					isComplete: true,
				}));
			}
		};

		exportConfig();

		return () => {
			isSubscribed = false;
		};
	}, [key, file, validateApiKeyScope]);

	if (state.error) {
		return (
			<>
				<Text color="red">Error: {state.error}</Text>
				{state.warnings.length > 0 && (
					<>
						<Text>Warnings:</Text>
						{state.warnings.map((warning, i) => (
							<Text key={i} color="yellow">
								- {warning}
							</Text>
						))}
					</>
				)}
			</>
		);
	}

	if (!state.isComplete) {
		return (
			<>
				<Text>
					<Spinner type="dots" />{' '}
					{state.status || 'Exporting environment configuration...'}
				</Text>
				{state.warnings.length > 0 && (
					<>
						<Text>Warnings:</Text>
						{state.warnings.map((warning, i) => (
							<Text key={i} color="yellow">
								- {warning}
							</Text>
						))}
					</>
				)}
			</>
		);
	}

	return (
		<>
			<Text color="green">Export completed successfully!</Text>
			{file && <Text>HCL content has been saved to: {file}</Text>}
			{state.warnings.length > 0 && (
				<>
					<Text>Warnings during export:</Text>
					{state.warnings.map((warning, i) => (
						<Text key={i} color="yellow">
							- {warning}
						</Text>
					))}
				</>
			)}
		</>
	);
};

export default function Export(props: Props) {
	return (
		<AuthProvider>
			<ExportContent {...props} />
		</AuthProvider>
	);
}