export async function seedRoles() {
  console.log('🔑 Role seeding skipped (using Enum roles)');
  return {
    'SUPER_ADMIN': { id: 'SUPER_ADMIN' },
    'FRANCHISE_ADMIN': { id: 'FRANCHISE_ADMIN' },
    'BRANCH_MANAGER': { id: 'FRANCHISE_ADMIN' } // Fallback
  };
}
