# Automation-jobs configuration
AUTOMATION_JOBS_REPO := stake-dao/automation-jobs
AUTOMATION_DEVOPS_DIR := $(shell pwd)/temp/automation-jobs
AUTOMATION_BRANCH ?= main

.PHONY: checkout-automation install-automation-deps clean-automation

checkout-automation:
	@echo "Checking out automation-jobs repository..."
	@mkdir -p temp
	@if [ -d "$(AUTOMATION_DEVOPS_DIR)" ]; then \
		cd $(AUTOMATION_DEVOPS_DIR) && git pull origin $(AUTOMATION_BRANCH); \
	else \
		if [ -n "$(GIT_ACCESS_TOKEN)" ]; then \
			git clone -b $(AUTOMATION_BRANCH) https://$(GIT_ACCESS_TOKEN)@github.com/$(AUTOMATION_JOBS_REPO).git $(AUTOMATION_DEVOPS_DIR); \
		else \
			git clone -b $(AUTOMATION_BRANCH) git@github.com:$(AUTOMATION_JOBS_REPO).git $(AUTOMATION_DEVOPS_DIR); \
		fi \
	fi

install-automation-deps: checkout-automation
	@echo "Installing dependencies for automation-jobs..."
	cd $(AUTOMATION_DEVOPS_DIR) && $(PIP) install -r requirements.txt

clean-automation:
	@echo "Cleaning up automation-jobs..."
	rm -rf temp/automation-jobs