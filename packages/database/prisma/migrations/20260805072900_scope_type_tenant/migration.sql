-- PostgreSQL requires a newly added enum value to be committed before a later
-- migration can use it in constraints or data.
ALTER TYPE "ScopeType" ADD VALUE 'TENANT';
