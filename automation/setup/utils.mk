# Helper function to execute transactions from calldatas.json
# Usage: $(call execute-transactions-from-json,$(AUTOMATION_DEVOPS_DIR),$(PRIVATE_KEY),$(WEB3_ALCHEMY_API_KEY))
define execute-transactions-from-json
	@echo "Executing transactions..."
	@if [ -f "$(1)/calldatas.json" ]; then \
		cd $(1) && \
		echo "\nProcessing transactions..." && \
		jq -c '.[]' calldatas.json > temp_transactions.json 2>/dev/null && \
		while IFS= read -r transaction; do \
			[ -z "$$transaction" ] && continue; \
			calldata=$$(echo "$$transaction" | jq -r '.calldata // .' 2>/dev/null) && \
			value=$$(echo "$$transaction" | jq -r '.value // "0"' 2>/dev/null) && \
			to_address=$$(echo "$$transaction" | jq -r '.to // "0x0000000a3Fc396B89e4c11841B39D9dff85a5D05"' 2>/dev/null) && \
			chain_id=$$(echo "$$transaction" | jq -r '.chain_id // "42161"' 2>/dev/null) && \
			increase_gas=$$(echo "$$transaction" | jq -r '.increase_gas // "1.2"' 2>/dev/null) && \
			case "$$chain_id" in \
				"1") rpc_url="https://eth-mainnet.g.alchemy.com/v2/$(3)" ;; \
				"137") rpc_url="https://polygon-mainnet.g.alchemy.com/v2/$(3)" ;; \
				"42161") rpc_url="https://arb-mainnet.g.alchemy.com/v2/$(3)" ;; \
				"10") rpc_url="https://opt-mainnet.g.alchemy.com/v2/$(3)" ;; \
				"8453") rpc_url="https://base-mainnet.g.alchemy.com/v2/$(3)" ;; \
				"59144") rpc_url="https://linea-mainnet.g.alchemy.com/v2/$(3)" ;; \
				*) echo "Unsupported chain ID: $$chain_id" && exit 1 ;; \
			esac && \
			echo "\nExecuting transaction for chain $$chain_id:" && \
			echo "To: $$to_address" && \
			echo "Value: $$value" && \
			echo "Calldata length: $$(echo $$calldata | wc -c) bytes" && \
			echo "RPC URL: $${rpc_url%/*}/***" && \
			./shells/execute_raw_transaction.sh --calldata "$$calldata" --value "$$value" --to-address "$$to_address" --increase-gas "$$increase_gas" --rpc-url "$$rpc_url" --private-key "$(2)" 2>&1 || true; \
		done < temp_transactions.json && \
		rm -f temp_transactions.json && \
		cd - > /dev/null && \
		echo "Finished executing all transactions" && \
		rm $(1)/calldatas.json; \
	else \
		echo "No calldatas.json file found in $(1)"; \
	fi
endef

# Helper function to run full execution (Python script + transaction execution) with retry
# Usage: $(call full-execution-with-retry,$(AUTOMATION_DEVOPS_DIR),script/bounties/sdPendle/distribute_rewards.py,$(PRIVATE_KEY),$(WEB3_ALCHEMY_API_KEY))
define full-execution-with-retry
	@echo "Starting full execution (Python + transactions) with retry..."
	@cd $(1) && \
	max_attempts=8; \
	wait_seconds=30; \
	attempt_num=1; \
	while [ $$attempt_num -le $$max_attempts ]; do \
		echo "Attempt $$attempt_num: Running Python script and transactions..."; \
		WEB3_ALCHEMY_API_KEY=$${WEB3_ALCHEMY_API_KEY%=} \
		PROD=True PYTHONPATH=script $(PYTHON) $(2); \
		\
		if [ -f "$(1)/calldatas.json" ]; then \
			echo "\nProcessing transactions..."; \
			tx_success=1; \
			jq -c '.[]' calldatas.json > temp_transactions.json; \
			while IFS= read -r transaction; do \
				[ -z "$$transaction" ] && continue; \
				calldata=$$(echo "$$transaction" | jq -r '.calldata // .'); \
				value=$$(echo "$$transaction" | jq -r '.value // "0"'); \
				to_address=$$(echo "$$transaction" | jq -r '.to // "0x0000000a3Fc396B89e4c11841B39D9dff85a5D05"'); \
				chain_id=$$(echo "$$transaction" | jq -r '.chain_id // "1"'); \
				increase_gas=$$(echo "$$transaction" | jq -r '.increase_gas // "1.2"'); \
				case "$$chain_id" in \
					"1") rpc_url="https://eth-mainnet.g.alchemy.com/v2/$(4)" ;; \
					"137") rpc_url="https://polygon-mainnet.g.alchemy.com/v2/$(4)" ;; \
					"42161") rpc_url="https://arb-mainnet.g.alchemy.com/v2/$(4)" ;; \
					"10") rpc_url="https://opt-mainnet.g.alchemy.com/v2/$(4)" ;; \
					"8453") rpc_url="https://base-mainnet.g.alchemy.com/v2/$(4)" ;; \
					"59144") rpc_url="https://linea-mainnet.g.alchemy.com/v2/$(4)" ;; \
					*) echo "Unsupported chain ID: $$chain_id"; tx_success=0; break ;; \
				esac; \
				echo "\nExecuting transaction for chain $$chain_id:"; \
				echo "To: $$to_address"; \
				echo "Value: $$value"; \
				echo "Calldata length: $$(echo $$calldata | wc -c) bytes"; \
				echo "RPC URL: $${rpc_url%/*}/***"; \
				./shells/execute_raw_transaction.sh --calldata "$$calldata" --value "$$value" --to-address "$$to_address" --increase-gas "$$increase_gas" --rpc-url "$$rpc_url" --private-key "$(3)"; \
				if [ $$? -ne 0 ]; then \
					echo "Transaction failed!"; \
					tx_success=0; \
					break; \
				fi; \
			done < temp_transactions.json; \
			rm -f temp_transactions.json; \
			\
			if [ "$$tx_success" -eq 1 ]; then \
				rm -f calldatas.json; \
				echo "All transactions executed successfully"; \
				break; \
			else \
				echo "Transaction execution failed. Retrying in $$wait_seconds seconds..."; \
			fi; \
		else \
			echo "No calldatas.json file found. Retrying in $$wait_seconds seconds..."; \
		fi; \
		attempt_num=$$((attempt_num + 1)); \
		sleep $$wait_seconds; \
	done; \
	\
	if [ $$attempt_num -gt $$max_attempts ]; then \
		echo "Full execution failed after $$max_attempts attempts."; \
		exit 1; \
	fi; \
	cd - > /dev/null
endef

# Helper function to log transactions on telegram
# Usage: $(call log-tx-on-telegram)
define log-tx-on-telegram
	@if [ "$(PROD)" = "True" ] && [ -n "$(CI)" ]; then \
		echo "Logging transactions on telegram..." && \
		cd $(AUTOMATION_DEVOPS_DIR) && \
		PYTHONPATH=script $(PYTHON) script/others/logger_workflow_script.py 0 && \
		cd - > /dev/null && \
		echo "Logged transactions on telegram"; \
	else \
		echo "Not logging transactions on telegram in test mode"; \
	fi
endef