import React, { createContext, useContext, useReducer, useEffect, useCallback, useMemo, ReactNode } from 'react';
import { createMongoAbility, type MongoAbility, type RawRuleOf, subject as caslSubject } from '@casl/ability';
import { api, configureAuthToken } from '@tx5dr/core';
import { buildAbilityRules, type PermissionGrant, type AppAction, type AppSubject } from '@tx5dr/contracts';
import type { UserRole, AuthStatus, AuthMeResponse } from '@tx5dr/contracts';
import i18n from '../i18n';
import { createLogger } from '../utils/logger';

const logger = createLogger('AuthStore');

// ===== 认证状态 =====

export interface AuthState {
  /** 是否已完成初始化检查 */
  initialized: boolean;
  /** 当前会话身份是否已收敛，可安全建立业务 WebSocket */
  sessionResolved: boolean;
  /** 服务端是否启用认证 */
  authEnabled: boolean;
  /** 是否允许公开查看 */
  allowPublicViewing: boolean;
  /** JWT Token */
  jwt: string | null;
  /** 当前用户角色（null = 未认证） */
  role: UserRole | null;
  /** Token 标签 */
  label: string | null;
  /** 被授权的操作员 ID */
  operatorIds: string[];
  /** 操作员数量上限 */
  maxOperators?: number;
  /** CASL permission grants */
  permissionGrants?: PermissionGrant[];
  /** 是否为未认证的公开观察者 */
  isPublicViewer: boolean;
  /** 登录错误信息 */
  loginError: string | null;
  /** 登录中 */
  loginLoading: boolean;
}

export type AuthAction =
  | { type: 'INIT_NO_AUTH' }
  | { type: 'AUTH_STATUS_LOADED'; payload: { allowPublicViewing: boolean } }
  | { type: 'LOGIN_START' }
  | { type: 'LOGIN_SUCCESS'; payload: { jwt: string; role: UserRole; label: string; operatorIds: string[]; maxOperators?: number; permissionGrants?: PermissionGrant[] } }
  | { type: 'LOGIN_FAIL'; payload: string }
  | { type: 'SET_PUBLIC_VIEWER' }
  | { type: 'RESTORE_SESSION'; payload: { jwt: string; role: UserRole; label: string; operatorIds: string[]; maxOperators?: number; permissionGrants?: PermissionGrant[] } }
  | { type: 'RESOLVE_UNAUTHENTICATED' }
  | { type: 'LOGOUT' }
  | { type: 'CLEAR_LOGIN_ERROR' };

const initialAuthState: AuthState = {
  initialized: false,
  sessionResolved: false,
  authEnabled: false,
  allowPublicViewing: true,
  jwt: null,
  role: null,
  label: null,
  operatorIds: [],
  isPublicViewer: false,
  loginError: null,
  loginLoading: false,
};

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'INIT_NO_AUTH':
      // 认证未启用 — 等同于 Admin（向后兼容）
      return {
        ...state,
        initialized: true,
        sessionResolved: true,
        authEnabled: false,
        role: 'admin' as UserRole,
        isPublicViewer: false,
      };

    case 'AUTH_STATUS_LOADED':
      return {
        ...state,
        initialized: true,
        sessionResolved: false,
        authEnabled: true,
        allowPublicViewing: action.payload.allowPublicViewing,
      };

    case 'LOGIN_START':
      return { ...state, loginLoading: true, loginError: null };

    case 'LOGIN_SUCCESS':
      return {
        ...state,
        initialized: true,
        sessionResolved: true,
        jwt: action.payload.jwt,
        role: action.payload.role,
        label: action.payload.label,
        operatorIds: action.payload.operatorIds,
        maxOperators: action.payload.maxOperators,
        permissionGrants: action.payload.permissionGrants,
        isPublicViewer: false,
        loginLoading: false,
        loginError: null,
      };

    case 'LOGIN_FAIL':
      return { ...state, loginLoading: false, loginError: action.payload };

    case 'SET_PUBLIC_VIEWER':
      return {
        ...state,
        initialized: true,
        sessionResolved: true,
        isPublicViewer: true,
        role: 'viewer' as UserRole,
        jwt: null,
        label: null,
        operatorIds: [],
        maxOperators: undefined,
        permissionGrants: undefined,
      };

    case 'RESTORE_SESSION':
      return {
        ...state,
        initialized: true,
        sessionResolved: true,
        jwt: action.payload.jwt,
        role: action.payload.role,
        label: action.payload.label,
        operatorIds: action.payload.operatorIds,
        maxOperators: action.payload.maxOperators,
        permissionGrants: action.payload.permissionGrants,
        isPublicViewer: false,
      };

    case 'RESOLVE_UNAUTHENTICATED':
      return {
        ...state,
        initialized: true,
        sessionResolved: true,
      };

    case 'LOGOUT':
      return {
        ...state,
        sessionResolved: true,
        jwt: null,
        role: state.authEnabled ? null : ('admin' as UserRole),
        label: null,
        operatorIds: [],
        maxOperators: undefined,
        permissionGrants: undefined,
        isPublicViewer: false,
        loginError: null,
      };

    case 'CLEAR_LOGIN_ERROR':
      return { ...state, loginError: null };

    default:
      return state;
  }
}

// ===== JWT 本地存储 =====

const JWT_STORAGE_KEY = 'tx5dr_jwt';

function saveJwt(jwt: string): void {
  try {
    localStorage.setItem(JWT_STORAGE_KEY, jwt);
  } catch {
    // localStorage 不可用时静默失败
  }
}

function loadJwt(): string | null {
  try {
    return localStorage.getItem(JWT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearJwt(): void {
  try {
    localStorage.removeItem(JWT_STORAGE_KEY);
  } catch {
    // 静默
  }
}

// ===== Context =====

interface AuthContextValue {
  state: AuthState;
  dispatch: React.Dispatch<AuthAction>;
  login: (token: string) => Promise<boolean>;
  logout: () => void;
  /** 已认证（含公开观察者） */
  isAuthenticated: boolean;
  /** 是否需要显示登录页（认证启用 + 不允许公开查看 + 未登录） */
  requiresLogin: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ===== Provider =====

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);

  // 同步 JWT 到 API 层
  useEffect(() => {
    configureAuthToken(state.jwt);
  }, [state.jwt]);

  // 初始化：检查认证状态
  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        // 1. 检查 URL 参数 ?auth_token=xxx（Electron 浏览器模式）
        const urlParams = new URLSearchParams(window.location.search);
        const urlToken = urlParams.get('auth_token');
        logger.info('Initializing auth, URL token present:', urlToken ? 'yes' : 'no');

        if (urlToken) {
          // 清除 URL 参数
          const cleanUrl = window.location.pathname + window.location.hash;
          window.history.replaceState({}, '', cleanUrl);

          // 直接用 URL token 登录
          try {
            logger.info('Logging in via URL token...');
            const resp = await api.login(urlToken);
            logger.info('URL token login succeeded', { role: resp.role, label: resp.label });
            if (!cancelled) {
              saveJwt(resp.jwt);
              configureAuthToken(resp.jwt);
              dispatch({
                type: 'LOGIN_SUCCESS',
                payload: {
                  jwt: resp.jwt,
                  role: resp.role,
                  label: resp.label,
                  operatorIds: resp.operatorIds,
                  maxOperators: resp.maxOperators,
                  permissionGrants: resp.permissionGrants,
                },
              });
            }
            return;
          } catch (err) {
            logger.error('URL token login failed:', err);
            // URL token 无效，继续正常流程
          }
        }

        // 2. 获取服务器认证状态
        let authStatus: AuthStatus;
        try {
          authStatus = await api.getAuthStatus();
          logger.info('Server auth status:', authStatus);
        } catch (err) {
          logger.error('Failed to fetch auth status:', err);
          // 服务器不可达 — 默认认证未启用（向后兼容旧服务器）
          if (!cancelled) {
            dispatch({ type: 'INIT_NO_AUTH' });
          }
          return;
        }

        if (!authStatus.enabled) {
          // 认证未启用
          if (!cancelled) {
            dispatch({ type: 'INIT_NO_AUTH' });
          }
          return;
        }

        // 认证已启用
        if (!cancelled) {
          dispatch({ type: 'AUTH_STATUS_LOADED', payload: { allowPublicViewing: authStatus.allowPublicViewing } });
        }

        // 4. 尝试恢复 localStorage 中的 JWT
        const savedJwt = loadJwt();
        if (savedJwt) {
          try {
            configureAuthToken(savedJwt);
            const me: AuthMeResponse = await api.getAuthMe();
            if (!cancelled) {
              dispatch({
                type: 'RESTORE_SESSION',
                payload: {
                  jwt: savedJwt,
                  role: me.role,
                  label: me.label,
                  operatorIds: me.operatorIds,
                  maxOperators: me.maxOperators,
                  permissionGrants: me.permissionGrants,
                },
              });
            }
            return;
          } catch {
            // JWT 无效或过期 — 清除
            clearJwt();
            configureAuthToken(null);
          }
        }

        // 5. 未认证：如果允许公开查看，自动设为公开观察者
        if (authStatus.allowPublicViewing && !cancelled) {
          dispatch({ type: 'SET_PUBLIC_VIEWER' });
        } else if (!cancelled) {
          dispatch({ type: 'RESOLVE_UNAUTHENTICATED' });
        }
        // 否则保持未认证状态，显示登录页
      } catch (err) {
        logger.error('Auth initialization failed:', err);
        if (!cancelled) {
          dispatch({ type: 'INIT_NO_AUTH' });
        }
      }
    }

    initialize();
    return () => { cancelled = true; };
  }, []);

  // 登录方法
  const login = useCallback(async (token: string): Promise<boolean> => {
    dispatch({ type: 'LOGIN_START' });
    try {
      const resp = await api.login(token);
      saveJwt(resp.jwt);
      configureAuthToken(resp.jwt);
      dispatch({
        type: 'LOGIN_SUCCESS',
        payload: {
          jwt: resp.jwt,
          role: resp.role,
          label: resp.label,
          operatorIds: resp.operatorIds,
          maxOperators: resp.maxOperators,
          permissionGrants: resp.permissionGrants,
        },
      });
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : i18n.t('auth:login.failed');
      dispatch({ type: 'LOGIN_FAIL', payload: message });
      return false;
    }
  }, []);

  // 登出方法
  const logout = useCallback(() => {
    clearJwt();
    configureAuthToken(null);
    dispatch({ type: 'LOGOUT' });

    // 如果允许公开查看，回到公开观察者模式
    if (state.allowPublicViewing) {
      dispatch({ type: 'SET_PUBLIC_VIEWER' });
    }
  }, [state.allowPublicViewing]);

  const isAuthenticated = state.role !== null;
  const requiresLogin = state.initialized && state.authEnabled && !state.allowPublicViewing && !isAuthenticated;

  const value: AuthContextValue = {
    state,
    dispatch,
    login,
    logout,
    isAuthenticated,
    requiresLogin,
  };

  return React.createElement(AuthContext.Provider, { value }, children);
}

// ===== Hooks =====

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}

/**
 * 检查当前用户是否至少拥有指定角色
 */
export function useHasMinRole(minRole: UserRole): boolean {
  const { state } = useAuth();
  if (!state.role) return false;
  const levels: Record<string, number> = { viewer: 0, operator: 1, admin: 2 };
  return (levels[state.role] ?? 0) >= (levels[minRole] ?? 0);
}

/**
 * 检查当前用户是否拥有指定操作员的访问权限
 */
export function useHasOperatorAccess(operatorId: string): boolean {
  const { state } = useAuth();
  if (!state.role) return false;
  if (state.role === 'admin') return true;
  return state.operatorIds.includes(operatorId);
}

// ===== CASL Ability Hooks =====

type AppAbility = MongoAbility<[string, string]>;

function createAbilityFromState(state: AuthState): AppAbility {
  if (!state.role) return createMongoAbility([]);
  return createMongoAbility(buildAbilityRules({
    role: state.role as import('@tx5dr/contracts').UserRole,
    operatorIds: state.operatorIds,
    permissionGrants: state.permissionGrants,
  }) as RawRuleOf<AppAbility>[]);
}

/**
 * Returns a CASL Ability instance that auto-updates with auth state.
 */
export function useAbility(): AppAbility {
  const { state } = useAuth();
  return useMemo(
    () => createAbilityFromState(state),
    [state.role, state.operatorIds, state.permissionGrants],
  );
}

/**
 * Convenience hook: check if current user can perform an action on a subject.
 */
export function useCan(action: AppAction, subject: AppSubject): boolean {
  const ability = useAbility();
  return ability.can(action as string, subject as string);
}

/**
 * Check ability with instance data (for conditional permissions like frequency restriction).
 */
export function useCanWithData(action: AppAction, subject: AppSubject, data: Record<string, unknown>): boolean {
  const ability = useAbility();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ability.can(action as string, caslSubject(subject as string, data as Record<PropertyKey, unknown>) as any);
}
