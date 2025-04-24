import { RoleRead, useRolesApi } from '../../../hooks/useRolesApi.js';
import {
	CreateTenantBody,
	CreateUserBody,
	useTenantApi,
} from '../../../hooks/useTenantApi.js';
import {
	ResourceRead,
	useResourcesApi,
} from '../../../hooks/useResourcesApi.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import randomName from '@scaleway/random-name';
import { GeneratePolicySnapshotProps } from '../GeneratePolicySnapshot.js';
import { useUserApi } from '../../../hooks/useUserApi.js';
import { saveFile } from '../../../utils/fileSaver.js';

type RBACResource = {
	type: string;
	tenant: string;
};

type RBACConfig = {
	user: string;
	action: string;
	resource: RBACResource;
	result: boolean;
};

type ABACUser = {
	key: string;
	attributes: {
		[key: string]: string;
	};
};

type ABACResource = {
	key: string;
	attributes: {
		[key: string]: string;
	};
};

type ABACConfig = {
	user: ABACUser;
	action: string;
	resource: ABACResource;
	result: boolean;
};

type ReBACConfig = {
	user: string;
	action: string;
	resource: string;
	result: boolean;
};

type AccessControlConfig = RBACConfig | ABACConfig | ReBACConfig;

type DryUser = {
	key: string;
	email: string;
	firstName: string;
	lastName: string;
	roles: string[];
};

export const useGeneratePolicySnapshot = ({
	dryRun,
	models,
	path,
	isTestTenant = true,
}: GeneratePolicySnapshotProps) => {
	const { getRoles } = useRolesApi();
	const { createTenant } = useTenantApi();
	const { getResources } = useResourcesApi();
	const { createUser } = useUserApi();

	const [roles, setRoles] = useState<RoleRead[]>([]);
	const [error, setError] = useState<null | string>(null);
	const [state, setState] = useState<
		| 'roles'
		| 'rbac-tenant'
		| 'rbac-users'
		| 'rbac-generate'
		| 'resources'
		| 'done'
	>('roles');
	const [tenantId, setTenantId] = useState<string | undefined>(undefined);
	const [modelsGenerated, setModelsGenerated] = useState<number>(0);
	const [finalConfig, setFinalConfig] = useState<AccessControlConfig[]>([]);
	const resourcesRef = useRef<ResourceRead[]>([]);
	const [dryUsers, setDryUsers] = useState<DryUser[]>([]);
	const generatedUsersRBACRef = useRef<string[]>([]);
	const userRoleMappingRBACRef = useRef<Record<string, RoleRead[]>>({});
	const [createdUsers, setCreatedUsers] = useState<DryUser[]>([]);
	const buildUserInfoFromUsername = useCallback((user: string) => {
		const [firstName = '', lastName = ''] = user.split(' ');
		return {
			key: firstName + lastName,
			email: firstName + lastName + '@gmail.com',
			firstName,
			lastName,
		};
	}, []);

	const createDryUsers = useCallback(
		(usernames: string[], userRoleMappings: Record<string, RoleRead[]>) => {
			const result: DryUser[] = [];
			for (const user of usernames) {
				const { key, email, firstName, lastName } =
					buildUserInfoFromUsername(user);
				const dryUser: DryUser = {
					key: key,
					firstName: firstName,
					lastName: lastName,
					email: email,
					roles: userRoleMappings[user]?.map(role => role.key) ?? [],
				};
				result.push(dryUser);
			}
			setDryUsers(result);
			// eslint-disable-next-line sonarjs/no-duplicate-string
			setState('rbac-generate');
		},
		[buildUserInfoFromUsername],
	);
	const createUserAndAttachRoles = useCallback(
		async (
			usernames: string[],
			userRoleMappings: Record<string, RoleRead[]>,
		) => {
			if (usernames.length === 0) {
				setState('rbac-generate');
				return;
			}

			try {
				for (const user of usernames) {
					const { key, email, firstName, lastName } =
						buildUserInfoFromUsername(user);

					const roles = userRoleMappings[user] || [];

					const body: CreateUserBody = {
						key: key,
						first_name: firstName,
						last_name: lastName,
						email: email,
						attributes: {},
						role_assignments: roles.map(role => ({
							role: role.key,
							tenant: tenantId || 'default',
						})),
					};

					const result = await createUser(body);

					if (result.error) {
						setError(result.error);
						return;
					}
					setCreatedUsers(prev => [
						...prev,
						{
							key: body.key,
							email: body.email ?? '',
							firstName: body.first_name ?? ' ',
							lastName: body.last_name ?? ' ',
							roles: body.role_assignments?.map(role => role.role) ?? [],
						},
					]);
				}
				setState('rbac-generate');
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[buildUserInfoFromUsername, createUser, tenantId],
	);

	const fetchRoles = useCallback(async () => {
		let { data, error } = await getRoles();
		if (error || data === undefined) {
			setError(error);
			return;
		}
		data = data as RoleRead[];
		if (data.length === 0) {
			setError('Environment has no Roles present');
			return;
		}
		setRoles(data as RoleRead[]);
		setState('rbac-tenant');
	}, [getRoles]);

	const fetchResources = useCallback(async () => {
		const { data, error } = await getResources();
		if (error) {
			setError(error);
			return;
		}
		resourcesRef.current = data as ResourceRead[];
		setState('rbac-users');
	}, [getResources]);

	const createNewTenant = useCallback(async () => {
		if (!isTestTenant) {
			setTenantId('default');
			setState('resources');
			return;
		}
		const name = 'test-tenant-' + randomName('', '');

		setTenantId(name);
		const body: CreateTenantBody = {
			key: name,
			name: name,
			description:
				'This is a tenant created by permit-cli for creating test users',
			attributes: {},
		};
		const { error } = await createTenant(body);
		if (error) {
			setError(error);
			return;
		}
		setState('resources');
	}, [createTenant, isTestTenant]);

	const generateRBACConfig = useCallback(() => {
		const config: RBACConfig[] = generatedUsersRBACRef.current.flatMap(user =>
			resourcesRef.current.flatMap(resource =>
				Object.entries(resource.actions).flatMap(([, action]) => {
					let result = false;
					userRoleMappingRBACRef.current[user]?.forEach(role => {
						result ||=
							role.permissions?.includes(`${resource.key}:${action.key}`) ??
							false;
					});
					const { key } = buildUserInfoFromUsername(user);
					return {
						user: key,
						action: action.key ?? '',
						resource: { type: resource.key, tenant: tenantId ?? '' },
						result: result,
					};
				}),
			),
		);

		setFinalConfig(prev => [...prev, ...config]);
		setModelsGenerated(prev => prev + 1);
	}, [buildUserInfoFromUsername, tenantId]);

	const saveConfigToPath = useCallback(async () => {
		// Write config as pretty JSON
		const json = JSON.stringify(
			dryRun
				? { users: dryUsers, config: finalConfig }
				: { config: finalConfig },
			null,
			2,
		);
		const { error } = await saveFile(path ?? '', json);
		if (error) {
			setError(error);
			return;
		}
		setState('done');
	}, [dryRun, dryUsers, finalConfig, path]);

	const generateUsersAndRoleMapping = useCallback(() => {
		let generatedUsers: string[] = [];
		const userRoleMappingRBAC: Record<string, RoleRead[]> = {};
		const userNoAccess = randomName('', ' ');
		generatedUsers.push(userNoAccess);
		userRoleMappingRBAC[userNoAccess] = [];
		roles.forEach(role => {
			const userAllAccess = randomName('', ' ');
			generatedUsers.push(userAllAccess);
			userRoleMappingRBAC[userAllAccess] = [role];
		});
		generatedUsersRBACRef.current = [
			...generatedUsersRBACRef.current,
			...generatedUsers,
		];
		userRoleMappingRBACRef.current = userRoleMappingRBAC;
		return { generatedUsers, userRoleMappingRBAC };
	}, [roles]);

	// Check if we have generated all config.
	useEffect(() => {
		if (modelsGenerated === models.length) {
			if (!path) {
				setTimeout(() => {
					setState('done');
				}, 1000);
			} else {
				saveConfigToPath();
			}
		}
	}, [models, modelsGenerated, path, saveConfigToPath]);

	// Step 1 : Get all roles and resources

	useEffect(() => {
		if (!models.includes('RBAC')) return;

		if (roles.length === 0 && state === 'roles') {
			fetchRoles();
		} else if (tenantId === undefined && state === 'rbac-tenant') {
			createNewTenant();
		} else if (resourcesRef.current.length === 0 && state === 'resources') {
			fetchResources();
		} else if (
			generatedUsersRBACRef.current.length === 0 &&
			state === 'rbac-users'
		) {
			const { generatedUsers, userRoleMappingRBAC } =
				generateUsersAndRoleMapping();
			if (dryRun) {
				createDryUsers(generatedUsers, userRoleMappingRBAC);
			} else {
				createUserAndAttachRoles(generatedUsers, userRoleMappingRBAC);
			}
		} else if (state === 'rbac-generate') {
			generateRBACConfig();
		}
	}, [
		createNewTenant,
		createDryUsers,
		createUserAndAttachRoles,
		dryRun,
		fetchResources,
		fetchRoles,
		generateRBACConfig,
		generateUsersAndRoleMapping,
		models,
		roles.length,
		state,
		tenantId,
	]);

	return {
		state,
		error,
		roles,
		tenantId,
		finalConfig,
		dryUsers,
		createdUsers,
	};
};
