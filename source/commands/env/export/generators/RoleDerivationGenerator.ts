import { Permit } from 'permitio';
import { HCLGenerator, WarningCollector } from '../types.js';
import Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
	ResourceRoleRead,
	RelationRead,
	ResourceRead,
} from 'permitio/build/main/openapi/types';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = dirname(currentFilePath);

interface PaginatedResponse<T> {
	data: T[];
	pagination?: {
		total_count?: number;
		page?: number;
		per_page?: number;
	};
}

interface RoleDerivationData {
	id: string;
	resource: string;
	role: string;
	linked_by: string;
	on_resource: string;
	to_role: string;
	dependencies: string[];
}

interface ResourceData {
	resource: ResourceRead;
	roles: ResourceRoleRead[];
	relations: RelationRead[];
}

interface ResourceRelation {
	sourceResourceKey: string;
	targetResourceKey: string;
	relation: RelationRead;
}

interface TerraformRelationMapping {
	relationKey: string;
	sourceResource: string;
	targetResource: string;
	terraformResourceName: string;
}

export class RoleDerivationGenerator implements HCLGenerator {
	name = 'role derivation';
	private template: Handlebars.TemplateDelegate<{
		derivations: RoleDerivationData[];
	}>;

	constructor(
		private permit: Permit,
		private warningCollector: WarningCollector,
	) {
		const templatePath = join(
			currentDirPath,
			'../templates/role-derivation.hcl',
		);
		const templateContent = readFileSync(templatePath, 'utf-8');
		this.template = Handlebars.compile(templateContent);
	}

	private async gatherResourceData(): Promise<Map<string, ResourceData>> {
		const resourceMap = new Map<string, ResourceData>();

		try {
			const resources = await this.permit.api.resources.list();

			if (!Array.isArray(resources) || !resources.length) return resourceMap;

			for (const resource of resources) {
				if (!resource.key) continue;

				try {
					const roles = await this.permit.api.resourceRoles.list({
						resourceKey: resource.key,
					});

					const relationsResponse =
						await this.permit.api.resourceRelations.list({
							resourceKey: resource.key,
						});

					const relations = Array.isArray(relationsResponse)
						? relationsResponse
						: (relationsResponse as PaginatedResponse<RelationRead>)?.data ||
							[];

					resourceMap.set(resource.key, {
						resource,
						roles: Array.isArray(roles) ? roles : [],
						relations,
					});
				} catch (error) {
					this.warningCollector.addWarning(
						`Failed to gather data for resource '${resource.key}': ${error}`,
					);
				}
			}
		} catch (error) {
			this.warningCollector.addWarning(`Failed to gather resources: ${error}`);
		}

		return resourceMap;
	}

	private getAllResourceRelations(
		resourceMap: Map<string, ResourceData>,
	): ResourceRelation[] {
		const relations: ResourceRelation[] = [];

		for (const [_, data] of resourceMap.entries()) {
			if (Array.isArray(data.relations)) {
				for (const relation of data.relations) {
					if (
						relation.key &&
						relation.subject_resource &&
						relation.object_resource
					) {
						relations.push({
							sourceResourceKey: relation.subject_resource,
							targetResourceKey: relation.object_resource,
							relation,
						});
					}
				}
			}
		}

		return relations;
	}

	private generateTerraformRelationName(relation: RelationRead): string {
		if (
			!relation.subject_resource ||
			!relation.object_resource ||
			!relation.key
		) {
			throw new Error(`Invalid relation: missing required properties`);
		}

		return `${relation.subject_resource}_${relation.object_resource}`;
	}

	private buildRelationMappings(
		relations: ResourceRelation[],
	): Map<string, TerraformRelationMapping> {
		const relationMappings = new Map<string, TerraformRelationMapping>();

		for (const {
			relation,
			sourceResourceKey,
			targetResourceKey,
		} of relations) {
			if (!relation.key) continue;

			const mappingKey = `${sourceResourceKey}:${relation.key}:${targetResourceKey}`;
			const terraformResourceName =
				this.generateTerraformRelationName(relation);

			relationMappings.set(mappingKey, {
				relationKey: relation.key,
				sourceResource: sourceResourceKey,
				targetResource: targetResourceKey,
				terraformResourceName,
			});
		}

		return relationMappings;
	}

	private createDerivationId(sourceRole: string, targetRole: string): string {
		const sanitizeId = (str: string) =>
			str.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
		return `${sanitizeId(sourceRole)}_to_${sanitizeId(targetRole)}`;
	}

	private async generateDerivations(
		resourceMap: Map<string, ResourceData>,
	): Promise<RoleDerivationData[]> {
		const derivations: RoleDerivationData[] = [];
		const relations = this.getAllResourceRelations(resourceMap);
		const relationMappings = this.buildRelationMappings(relations);

		for (const [resourceKey, resourceData] of resourceMap.entries()) {
			for (const role of resourceData.roles) {
				if (!role.key || !role.granted_to?.users_with_role?.length) continue;

				for (const grantInfo of role.granted_to.users_with_role) {
					if (
						!grantInfo.role ||
						!grantInfo.on_resource ||
						!grantInfo.linked_by_relation
					) {
						continue;
					}

					const sourceRoleKey = grantInfo.role;
					const sourceResourceKey = grantInfo.on_resource;
					const relationKey = grantInfo.linked_by_relation;
					const targetResourceKey = resourceKey;
					const targetRoleKey = role.key;

					const mappingKey = `${sourceResourceKey}:${relationKey}:${targetResourceKey}`;
					const relationMapping = relationMappings.get(mappingKey);

					if (!relationMapping) {
						this.warningCollector.addWarning(
							`Could not find relation mapping for ${mappingKey}`,
						);
						continue;
					}

					const derivationId = this.createDerivationId(
						sourceRoleKey,
						targetRoleKey,
					);

					const dependencies: string[] = [
						`permitio_role.${sourceRoleKey}`,
						`permitio_resource.${sourceResourceKey}`,
						`permitio_role.${targetRoleKey}`,
						`permitio_resource.${targetResourceKey}`,
						`permitio_relation.${relationMapping.terraformResourceName}`,
					];

					derivations.push({
						id: derivationId,
						role: sourceRoleKey,
						on_resource: sourceResourceKey,
						to_role: targetRoleKey,
						resource: targetResourceKey,
						linked_by: relationMapping.terraformResourceName,
						dependencies: dependencies,
					});
				}
			}
		}

		return derivations;
	}

	async generateHCL(): Promise<string> {
		try {
			const resourceMap = await this.gatherResourceData();
			if (resourceMap.size === 0) return '';

			const derivations = await this.generateDerivations(resourceMap);
			if (derivations.length === 0) return '';

			const hcl = this.template({ derivations });
			return '\n# Role Derivations\n' + hcl;
		} catch (error) {
			this.warningCollector.addWarning(
				`Failed to generate role derivations: ${error}`,
			);
			return '';
		}
	}
}
