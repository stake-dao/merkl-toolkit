include setup/dotenv.mk
include setup/python.mk
include setup/automation-jobs.mk
include setup/utils.mk

.PHONY: all setup install-deps run-set-roots clean

# Define the default target
.DEFAULT_GOAL := all

# Chain ID for Mainnet network
CHAIN_ID = 1

all: setup install-deps run-set-roots

setup: setup-python checkout-automation

install-deps: install-automation-deps

run-set-roots: setup install-deps
ifeq ($(PROD),True)
	@echo "Running set_roots script in execution mode ..."
	@cd $(AUTOMATION_DEVOPS_DIR) && \
	WEB3_ALCHEMY_API_KEY=$${WEB3_ALCHEMY_API_KEY%=} \
	PROD=True PYTHONPATH=script $(PYTHON) script/votemarket/v2/hook_incentives_set_root.py || \
	(echo "❌ set_roots script failed with exit code $$?" && exit 1)
	@cd - > /dev/null
	@echo "set_roots script executed successfully"
	@$(MAKE) -f automation/set_roots.mk execute-transactions
else
	@echo "Running set_roots script in test mode ..."
	@cd $(AUTOMATION_DEVOPS_DIR) && \
	WEB3_ALCHEMY_API_KEY=$${WEB3_ALCHEMY_API_KEY%=} \
	PYTHONPATH=script $(PYTHON) sscript/votemarket/v2/hook_incentives_set_root.py || \
	(echo "❌ set_roots script failed with exit code $$?" && exit 1)
	@cd - > /dev/null
	@echo "set_roots script completed successfully"
endif

execute-transactions:
	$(call execute-transactions-from-json,$(AUTOMATION_DEVOPS_DIR),$(PRIVATE_KEY),$(WEB3_ALCHEMY_API_KEY))

clean: